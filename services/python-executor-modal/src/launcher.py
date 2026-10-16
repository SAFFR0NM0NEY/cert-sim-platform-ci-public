"""Trusted CertSim learner boundary for disposable Modal Sandboxes."""

import ctypes
import errno
import json
import os
import platform
import re
import resource
import shutil
import sys


LEARNER_UID = 65534
LEARNER_GID = 65534
WORKSPACE_BYTES = 16 * 1024 * 1024
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024
MAX_TOTAL_SOURCE_BYTES = 256 * 1024
MAX_FILES = 16
MAX_CPU_SECONDS = 4
MAX_PROCESSES = 1
LAUNCHER_RESERVED_EXIT_CODE = 125

# Fixed trusted runtime closure. This is loaded while the host stdlib is still
# reachable; learner execution keeps the chroot and workspace-only sys.path.
TRUSTED_STDLIB_PRELOAD = (
    "ast",
    "base64",
    "builtins",
    "contextlib",
    "datetime",
    "io",
    "json",
    "math",
    "os",
    "pathlib",
    "random",
    "socket",
    "sys",
    "tempfile",
    "unittest",
)

CLONE_NEWNS = 0x00020000
CLONE_NEWPID = 0x20000000
CLONE_NEWUSER = 0x10000000
MS_NODEV = 4
MS_NOEXEC = 8
MS_NOSUID = 2
MS_PRIVATE = 1 << 18
MS_REC = 16384
MNT_DETACH = 2

PR_GET_NO_NEW_PRIVS = 39
PR_GET_SECCOMP = 21
PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2
SECCOMP_RET_ALLOW = 0x7FFF0000
SECCOMP_RET_ERRNO = 0x00050000
BPF_LD_W_ABS = 0x20
BPF_JMP_JEQ_K = 0x15
BPF_RET_K = 0x06
LINUX_CAPABILITY_VERSION_3 = 0x20080522

PATH_PATTERN = re.compile(r"^[A-Za-z0-9._/-]+$")
LIBC = ctypes.CDLL(None, use_errno=True)

SAFE_OPERATION_NAMES = {
    "bounded-tmpfs": "tmpfs_mount",
    "capget": "capability_check",
    "clear-capabilities": "capability_drop",
    "gid-mapping": "gid_mapping",
    "namespace-mapping-rejected": "namespace_mapping",
    "no-new-privileges": "no_new_privs_setup",
    "private-mounts": "mount_setup",
    "seccomp-filter": "seccomp_setup",
    "uid-mapping": "uid_mapping",
    "user-mount-pid-namespaces": "namespace_setup",
}


class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint),
    ]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]


def errno_name():
    value = ctypes.get_errno()
    return errno.errorcode.get(value, str(value))


def safe_error(error, fallback="launcher_setup"):
    if isinstance(error, RuntimeError) and error.args:
        value = error.args[0]
        if value == "unsupported-seccomp-architecture":
            return "unsupported_architecture"
        if value == "stdlib-preload-policy":
            return "stdlib_preload:POLICY"
        if value == "stdlib-preload-import":
            return "stdlib_preload:IMPORT"
        if isinstance(value, str) and ":" in value:
            operation, error_name = value.split(":", 1)
            safe_operation = SAFE_OPERATION_NAMES.get(operation)
            if safe_operation and error_name in set(errno.errorcode.values()):
                return f"{safe_operation}:{error_name}"
    if isinstance(error, OSError):
        return f"{fallback}:{errno.errorcode.get(error.errno, 'OTHER')}"
    return f"{fallback}:OTHER"


def require_zero(result, operation):
    if result != 0:
        raise RuntimeError(f"{operation}:{errno_name()}")


def write_mapping(path, entries, operation):
    try:
        with open(path, "w", encoding="ascii") as handle:
            handle.write("".join(f"{inside} {outside} {count}\n" for inside, outside, count in entries))
    except OSError as error:
        error_name = errno.errorcode.get(error.errno, "OTHER")
        raise RuntimeError(f"{operation}:{error_name}") from None


def preload_trusted_stdlib():
    if any(name not in sys.stdlib_module_names for name in TRUSTED_STDLIB_PRELOAD):
        raise RuntimeError("stdlib-preload-policy")
    try:
        for module_name in TRUSTED_STDLIB_PRELOAD:
            __import__(module_name)
    except (ImportError, OSError):
        raise RuntimeError("stdlib-preload-import") from None


def effective_capabilities():
    header = CapHeader(LINUX_CAPABILITY_VERSION_3, 0)
    values = (CapData * 2)()
    require_zero(LIBC.capget(ctypes.byref(header), values), "capget")
    return values[0].effective | values[1].effective << 32


def clear_capabilities():
    header = CapHeader(LINUX_CAPABILITY_VERSION_3, 0)
    values = (CapData * 2)()
    require_zero(LIBC.capset(ctypes.byref(header), values), "clear-capabilities")


def blocked_syscalls_x86_64():
    return [
        56, 57, 58, 435,
        59, 322,
        101,
        105, 106, 113, 114, 116, 117, 118, 119, 121, 122, 123, 126,
        155, 161, 165, 166,
        167, 168, 169,
        175, 176, 313,
        246, 248, 249, 250,
        272, 298, 303, 308, 321, 323,
    ]


def install_seccomp_filter():
    if platform.machine().lower() not in ("x86_64", "amd64"):
        raise RuntimeError("unsupported-seccomp-architecture")
    instructions = [SockFilter(BPF_LD_W_ABS, 0, 0, 0)]
    for syscall_number in blocked_syscalls_x86_64():
        instructions.append(SockFilter(BPF_JMP_JEQ_K, 0, 1, syscall_number))
        instructions.append(SockFilter(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | errno.EPERM))
    instructions.append(SockFilter(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW))
    instruction_array = (SockFilter * len(instructions))(*instructions)
    program = SockFprog(len(instructions), instruction_array)
    require_zero(LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no-new-privileges")
    require_zero(
        LIBC.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(program), 0, 0),
        "seccomp-filter",
    )


def enter_namespaces(ready_fd, continue_fd):
    os.setgroups([])
    require_zero(
        LIBC.unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID),
        "user-mount-pid-namespaces",
    )
    os.write(ready_fd, b"R")
    os.close(ready_fd)
    if os.read(continue_fd, 1) != b"G":
        raise RuntimeError("namespace-mapping-rejected")
    os.close(continue_fd)
    require_zero(LIBC.mount(None, b"/", None, MS_REC | MS_PRIVATE, None), "private-mounts")


def map_child_namespace(child_pid):
    try:
        with open(f"/proc/{child_pid}/setgroups", "w", encoding="ascii") as handle:
            handle.write("deny")
    except OSError:
        pass
    write_mapping(
        f"/proc/{child_pid}/uid_map",
        [(LEARNER_UID, os.getuid(), 1)],
        "uid-mapping",
    )
    write_mapping(
        f"/proc/{child_pid}/gid_map",
        [(LEARNER_GID, os.getgid(), 1)],
        "gid-mapping",
    )


def validate_path(path):
    if not isinstance(path, str) or not path or len(path.encode("utf-8")) > 240:
        raise ValueError("invalid-path")
    if not path.endswith(".py") or not PATH_PATTERN.fullmatch(path):
        raise ValueError("invalid-path")
    if path.startswith("/") or "//" in path:
        raise ValueError("invalid-path")
    if any(segment in ("", ".", "..") for segment in path.split("/")):
        raise ValueError("invalid-path")
    return path


def validate_payload(value):
    if not isinstance(value, dict) or set(value) != {"entryPoint", "files"}:
        raise ValueError("invalid-payload")
    files = value["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError("invalid-files")
    normalized = []
    seen = set()
    total = 0
    for item in files:
        if not isinstance(item, dict) or set(item) != {"content", "path"}:
            raise ValueError("invalid-file")
        path = validate_path(item["path"])
        portable = path.lower()
        if portable in seen:
            raise ValueError("duplicate-path")
        seen.add(portable)
        content = item["content"]
        if not isinstance(content, str):
            raise ValueError("invalid-content")
        content_bytes = content.encode("utf-8", errors="strict")
        if len(content_bytes) > MAX_FILE_BYTES:
            raise ValueError("file-too-large")
        total += len(content_bytes)
        if total > MAX_TOTAL_SOURCE_BYTES:
            raise ValueError("workspace-too-large")
        normalized.append((path, content_bytes))
    entry_point = validate_path(value["entryPoint"])
    if entry_point not in {path for path, _ in normalized}:
        raise ValueError("entry-point-missing")
    return entry_point, normalized


def create_workspace(files):
    mountpoint = f"/tmp/certsim-python-{os.getpid()}"
    os.makedirs(mountpoint, mode=0o700, exist_ok=False)
    options = f"size={WORKSPACE_BYTES},nr_inodes=1024,mode=0555".encode("ascii")
    require_zero(
        LIBC.mount(
            b"tmpfs",
            mountpoint.encode("utf-8"),
            b"tmpfs",
            MS_NOSUID | MS_NODEV | MS_NOEXEC,
            options,
        ),
        "bounded-tmpfs",
    )
    workspace = os.path.join(mountpoint, "workspace")
    os.mkdir(workspace, mode=0o700)
    os.chown(workspace, LEARNER_UID, LEARNER_GID)
    for relative_path, content in files:
        target = os.path.join(workspace, *relative_path.split("/"))
        parent = os.path.dirname(target)
        os.makedirs(parent, mode=0o700, exist_ok=True)
        cursor = parent
        while cursor != workspace:
            os.chown(cursor, LEARNER_UID, LEARNER_GID)
            cursor = os.path.dirname(cursor)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, content)
        finally:
            os.close(descriptor)
        os.chown(target, LEARNER_UID, LEARNER_GID)
    stats = os.statvfs(mountpoint)
    return mountpoint, stats.f_frsize * stats.f_blocks


def learner_attestation():
    return {
        "uid": os.getuid(),
        "euid": os.geteuid(),
        "gid": os.getgid(),
        "egid": os.getegid(),
        "groups": os.getgroups(),
        "pid": os.getpid(),
        "effectiveCapabilities": effective_capabilities(),
        "noNewPrivileges": LIBC.prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0),
        "seccompMode": LIBC.prctl(PR_GET_SECCOMP, 0, 0, 0, 0),
        "nproc": list(resource.getrlimit(resource.RLIMIT_NPROC)),
        "cpuSeconds": list(resource.getrlimit(resource.RLIMIT_CPU)),
        "fileSizeBytes": list(resource.getrlimit(resource.RLIMIT_FSIZE)),
        "environmentNames": sorted(os.environ),
    }


def sanitize_learner_exit_code(value):
    if isinstance(value, int) and 0 <= value <= 255 and value != LAUNCHER_RESERVED_EXIT_CODE:
        return value
    return 1


def run_learner(entry_point, mountpoint, attestation_fd, proceed_fd):
    os.chroot(mountpoint)
    os.chdir("/workspace")
    resource.setrlimit(resource.RLIMIT_NPROC, (MAX_PROCESSES, MAX_PROCESSES))
    resource.setrlimit(resource.RLIMIT_CPU, (MAX_CPU_SECONDS, MAX_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (WORKSPACE_BYTES, WORKSPACE_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    os.setgid(LEARNER_GID)
    os.setuid(LEARNER_UID)
    os.environ.clear()
    entry_directory = os.path.dirname(f"/workspace/{entry_point}")
    sys.path[:] = [entry_directory]
    if entry_directory != "/workspace":
        sys.path.append("/workspace")
    sys.argv[:] = [entry_point]
    clear_capabilities()
    install_seccomp_filter()
    attestation = json.dumps(learner_attestation(), sort_keys=True).encode("utf-8")
    os.write(attestation_fd, attestation)
    os.close(attestation_fd)
    if os.read(proceed_fd, 1) != b"G":
        return 125
    os.close(proceed_fd)
    os.close(0)
    os.closerange(3, 1024)
    source_path = f"/workspace/{entry_point}"
    with open(source_path, "rb") as handle:
        source = handle.read(MAX_FILE_BYTES + 1)
    if len(source) > MAX_FILE_BYTES:
        return 125
    namespace = {"__name__": "__main__", "__file__": source_path}
    try:
        exec(compile(source, source_path, "exec"), namespace, namespace)
        return 0
    except SystemExit as error:
        return sanitize_learner_exit_code(error.code)
    except BaseException as error:
        sys.stderr.write(f"LEARNER_ERROR:{type(error).__name__}\n")
        return 1


def execute_isolated_request(entry_point, files):
    mountpoint = None
    try:
        mountpoint, observed_workspace_bytes = create_workspace(files)
        read_fd, write_fd = os.pipe()
        proceed_read, proceed_write = os.pipe()
        child_pid = os.fork()
        if child_pid == 0:
            os.close(read_fd)
            os.close(proceed_write)
            try:
                exit_code = run_learner(entry_point, mountpoint, write_fd, proceed_read)
            except BaseException as error:
                try:
                    os.write(
                        write_fd,
                        json.dumps({"setupError": safe_error(error)}).encode("utf-8"),
                    )
                except OSError:
                    pass
                exit_code = LAUNCHER_RESERVED_EXIT_CODE
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(exit_code)

        os.close(write_fd)
        os.close(proceed_read)
        attestation_bytes = os.read(read_fd, 8192)
        os.close(read_fd)
        report = {
            "namespaceSetup": True,
            "workspaceBytes": observed_workspace_bytes,
            "workspaceFlags": ["nodev", "noexec", "nosuid"],
            "learner": json.loads(attestation_bytes or b"{}"),
        }
        sys.stderr.write(f"CERTSIM_MODAL_LAUNCHER={json.dumps(report, sort_keys=True)}\n")
        sys.stderr.flush()
        os.write(proceed_write, b"G")
        os.close(proceed_write)
        _, status = os.waitpid(child_pid, 0)
        child_exit_code = os.waitstatus_to_exitcode(status)
        files = None
        cleanup_ok = LIBC.umount2(mountpoint.encode("utf-8"), MNT_DETACH) == 0
        shutil.rmtree(mountpoint, ignore_errors=True)
        if not cleanup_ok or os.path.exists(mountpoint):
            return LAUNCHER_RESERVED_EXIT_CODE
        return child_exit_code if child_exit_code >= 0 else 128 - child_exit_code
    finally:
        if mountpoint and os.path.exists(mountpoint):
            LIBC.umount2(mountpoint.encode("utf-8"), MNT_DETACH)
            shutil.rmtree(mountpoint, ignore_errors=True)


def main():
    preload_trusted_stdlib()
    payload_bytes = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
    if len(payload_bytes) > MAX_PAYLOAD_BYTES:
        raise RuntimeError("payload-too-large")
    payload = json.loads(payload_bytes.decode("utf-8", errors="strict"))
    entry_point, files = validate_payload(payload)
    ready_read, ready_write = os.pipe()
    continue_read, continue_write = os.pipe()
    setup_pid = os.fork()
    if setup_pid == 0:
        os.close(ready_read)
        os.close(continue_write)
        try:
            enter_namespaces(ready_write, continue_read)
            exit_code = execute_isolated_request(entry_point, files)
        except BaseException as error:
            sys.stderr.write(f"CERTSIM_MODAL_SETUP_ERROR={safe_error(error)}\n")
            exit_code = LAUNCHER_RESERVED_EXIT_CODE
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(exit_code)

    os.close(ready_write)
    os.close(continue_read)
    ready = os.read(ready_read, 1)
    os.close(ready_read)
    mapping_ok = False
    if ready == b"R":
        try:
            map_child_namespace(setup_pid)
            mapping_ok = True
        except BaseException as error:
            sys.stderr.write(
                f"CERTSIM_MODAL_MAPPING_ERROR={safe_error(error, 'uid_mapping')}\n"
            )
    os.write(continue_write, b"G" if mapping_ok else b"X")
    os.close(continue_write)
    payload = None
    files = None
    _, status = os.waitpid(setup_pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    try:
        result = main()
    except BaseException as error:
        sys.stderr.write(f"CERTSIM_MODAL_SETUP_ERROR={safe_error(error)}\n")
        raise SystemExit(LAUNCHER_RESERVED_EXIT_CODE)
    raise SystemExit(result)
