import { parseTopology } from "./persistence.ts";
import { createRuntime } from "./networkRuntime.ts";
import { runPdu } from "./pdus.ts";
import type {
  Topology,
  NativeFile,
  PackageBackground,
  PackageEdits,
  PackageResource,
  UserPdu,
} from "./types.ts";

const LIMIT = 8 * 1024 * 1024;
const STORE = "originals";
export const NATIVE_STUDIO_URL = "http://127.0.0.1:42397/network-studio.html";
export function isNativeLauncher() {
  return (
    location.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(location.hostname) &&
    location.port === new URL(NATIVE_STUDIO_URL).port
  );
}

async function postNative(
  path: string,
  body: BodyInit,
  headers: Record<string, string> = {},
) {
  if (
    location.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(location.hostname)
  ) {
    throw Error(
      "Open the local Network Studio native-file launcher to work with Packet Tracer files.",
    );
  }
  const url =
    location.port === "4188" || location.port === "4189"
      ? "http://127.0.0.1:42397"
      : location.origin;
  let response: Response;
  try {
    const send = () =>
      fetch(url + "/native/" + path, {
        method: "POST",
        headers: { "X-CertSim-Native": "1", ...headers },
        body,
      });
    response = await send();
    for (const wait of [100, 250, 500, 1000, 2000]) {
      if (response.status !== 409) break;
      await response.body?.cancel();
      await new Promise((resolve) => window.setTimeout(resolve, wait));
      response = await send();
    }
  } catch {
    throw Error(
      "Start the local Network Studio native-file launcher and try again.",
    );
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(
      error.error ||
        "The local native-file helper could not process this document.",
    );
  }
  return response;
}

// The helper processes one native operation at a time, including background reads.
let pendingRequest = Promise.resolve();
function request<T>(
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
  read: (response: Response) => Promise<T>,
) {
  const result = pendingRequest
    .then(() => postNative(path, body, headers))
    .then(read);
  pendingRequest = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Commit the source blob before the workspace can refer to it in localStorage.
async function attachment(
  key: string,
  file?: Blob,
  resourceName?: string,
): Promise<Blob> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("certsim-native-files", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () =>
      reject(Error("The browser could not open native file storage."));
    open.onsuccess = () => resolve(open.result);
  });
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const tx = db.transaction(STORE, file ? "readwrite" : "readonly");
      const store = tx.objectStore(STORE);
      const op = file ? store.put(file, key) : store.get(key);
      tx.oncomplete = () => {
        const saved = file ?? op.result;
        if (saved instanceof Blob) resolve(saved);
        else
          reject(
            Error(
              resourceName
                ? "Remove and add “" +
                    resourceName +
                    "” again to restore its package attachment in this browser."
                : "Reopen the original Packet Tracer file in this browser to restore its native attachment.",
            ),
          );
      };
      tx.onabort = tx.onerror = () =>
        reject(Error("The browser could not retain the original native file."));
    });
  } finally {
    db.close();
  }
}

async function fileKey(file: File) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

export function nativeActivity(network: Topology) {
  const ref = network.nativeFile;
  if (
    ref?.format === "pka" ||
    (ref?.format === "pkz" && ref.documentFormat === "pka")
  )
    return ref;
}

export async function openNative(file: File, format: NativeFile["format"]) {
  if (!file.size || file.size > LIMIT)
    throw Error("Select a native file up to 8 MiB.");
  const name =
    file.name.replace(/\.(pkt|pka|pkz)$/i, "").slice(0, 80) ||
    "Imported network";
  const {
    network,
    pages,
    omitted,
    readOnly,
    documentFormat,
    resources,
    background,
  } = await request(
    "open/" + format,
    file,
    { "X-Studio-Name": encodeURIComponent(name) },
    (response) => response.json(),
  );
  if (readOnly === true)
    return {
      readOnly: true as const,
      name: file.name,
      pages: pages as string[],
    };
  const key = await fileKey(file);
  const topology = parseTopology(
    JSON.stringify({
      ...network,
      nativeFile: {
        key,
        name,
        format,
        pages,
        documentFormat,
        resources,
        background,
      },
    }),
  );
  const details = Object.entries(omitted).map(
    ([kind, count]) => `${count} ${kind}`,
  );
  await attachment(key, file);
  return {
    readOnly: false as const,
    topology,
    details: details.length
      ? " Retained outside the canvas: " + details.join(", ") + "."
      : "",
  };
}

export function packageResources(network: Topology): PackageResource[] {
  const original =
    network.nativeFile?.format === "pkz" ? network.nativeFile.resources : [];
  const edits = network.packageEdits;
  return edits
    ? [...original.filter((r) => !edits.remove.includes(r.name)), ...edits.add]
    : original;
}

export function packageBackground(network: Topology) {
  const ref = network.nativeFile;
  const override = network.packageEdits?.background;
  return override !== undefined
    ? override
    : ref?.format === "pkz"
      ? ref.background
      : undefined;
}

function withPackageEdits(network: Topology, edits: PackageEdits): Topology {
  if (edits.add.length || edits.remove.length || edits.background !== undefined)
    return { ...network, packageEdits: edits };
  const { packageEdits: _unused, ...rest } = network;
  return rest;
}

export function setPackageBackground(
  network: Topology,
  background: PackageBackground | null,
) {
  const original =
    network.nativeFile?.format === "pkz"
      ? network.nativeFile.background
      : undefined;
  const edits = { ...(network.packageEdits ?? { add: [], remove: [] }) };
  if (
    original?.name === background?.name &&
    original?.tiled === background?.tiled
  )
    delete edits.background;
  else edits.background = background;
  return withPackageEdits(network, edits);
}

export async function addPackageFiles(
  network: Topology,
  files: File[],
  replaceName?: string,
) {
  const edits = network.packageEdits ?? { add: [], remove: [] };
  const replacing = replaceName
    ? packageFileSource(network, replaceName)
    : undefined;
  if (replaceName && (!replacing || files.length !== 1))
    throw Error("Select one replacement for an existing package file.");
  const visible = packageResources(network).filter(
    (entry) => entry.name !== replaceName,
  );
  if (visible.length + files.length > 255)
    throw Error("A package can contain at most 255 additional files.");
  if (
    [...visible, ...files].reduce((bytes, file) => bytes + file.size, 0) >
    48 * 1024 * 1024
  )
    throw Error("Package files exceed the 48 MiB expanded limit.");
  const names = new Set(
    visible.map((r) => r.name.normalize("NFC").toLowerCase()),
  );
  const add = edits.add.filter((entry) => entry.name !== replaceName);
  for (const file of files) {
    const name = (replaceName ?? file.name).normalize("NFC").toLowerCase();
    if (names.has(name))
      throw Error(
        "A package file named “" +
          file.name +
          "” already exists. Use Replace to update it.",
      );
    if (file.size > LIMIT) throw Error("Select a package file up to 8 MiB.");
    names.add(name);
  }
  for (const file of files) {
    const key = await fileKey(file);
    await attachment(key, file);
    add.push({ name: replaceName ?? file.name, size: file.size, key });
  }
  const remove = replacing?.packaged
    ? [...edits.remove, replacing.name]
    : edits.remove;
  return { ...network, packageEdits: { ...edits, add, remove } };
}

export function removePackageFile(network: Topology, name: string): Topology {
  const edits = network.packageEdits ?? { add: [], remove: [] };
  const add = edits.add.filter((r) => r.name !== name);
  const remove =
    add.length < edits.add.length ? edits.remove : [...edits.remove, name];
  const next = withPackageEdits(network, { ...edits, add, remove });
  return packageBackground(network)?.name === name
    ? setPackageBackground(next, null)
    : next;
}

export function packageFileSource(network: Topology, name: string) {
  const staged = network.packageEdits?.add.find((entry) => entry.name === name);
  if (staged) return { key: staged.key, name, packaged: false };
  const ref = network.nativeFile;
  if (
    ref?.format === "pkz" &&
    !network.packageEdits?.remove.includes(name) &&
    ref.resources.some((entry) => entry.name === name)
  )
    return { key: ref.key, name, packaged: true };
}

export interface PackageFileSource {
  key: string;
  name: string;
  packaged: boolean;
}

export async function packageFileBlob({
  key,
  name,
  packaged,
}: PackageFileSource) {
  if (!packaged) return attachment(key, undefined, name);
  const source = await asBase64(await attachment(key));
  return request(
    "resource",
    JSON.stringify({ source, name }),
    {
      "Content-Type": "application/json",
    },
    (response) => response.blob(),
  );
}

export async function downloadPackageFile(network: Topology, name: string) {
  const source = packageFileSource(network, name);
  if (!source) throw Error("The file is missing from this package.");
  const blob = await packageFileBlob(source);
  const filename = name.replace(/^.*[\\/]/, "");
  downloadFile(
    new Blob([blob], { type: "application/octet-stream" }),
    filename,
  );
}

function asBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(Error("Could not read the original native file."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

export async function saveNative(
  topology: Topology,
  format: NativeFile["format"],
) {
  const { packageEdits, ...network } = topology;
  if (network.activity?.initial.packageEdits) {
    const { packageEdits: _edits, ...initial } = network.activity.initial;
    network.activity = { ...network.activity, initial };
  }
  if (packageEdits && format !== "pkz")
    throw Error("Save as .pkz to include the package files.");
  const source = network.nativeFile
    ? await asBase64(await attachment(network.nativeFile.key))
    : undefined;
  const resources = packageEdits
    ? await resourcePayload(packageEdits)
    : undefined;
  return request(
    "save",
    JSON.stringify({ format, source, network, resources }),
    { "Content-Type": "application/json" },
    (response) => response.blob(),
  );
}

async function resourcePayload(edits: PackageEdits) {
  const add = [];
  for (const resource of edits.add) {
    const data = await asBase64(
      await attachment(resource.key, undefined, resource.name),
    );
    add.push({ name: resource.name, data });
  }
  return { add, remove: edits.remove, background: edits.background };
}

export async function checkNative(network: Topology) {
  const ref = nativeActivity(network);
  if (!ref) throw Error("Open a native activity first.");
  const source = await asBase64(await attachment(ref.key));
  async function score(observations: Record<string, boolean>) {
    const result = await request(
      "check",
      JSON.stringify({ network, source, observations }),
      { "Content-Type": "application/json" },
      (response) => response.json(),
    );
    return result as {
      earned: number;
      total: number;
      unmapped: number;
      probes: UserPdu[];
    };
  }
  let result = await score({});
  if (result.probes.length) {
    const observations: Record<string, boolean> = {};
    for (const probe of result.probes)
      observations[probe.id] = runPdu(network, probe, createRuntime()).ok;
    result = await score(observations);
  }
  return result;
}

export function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
