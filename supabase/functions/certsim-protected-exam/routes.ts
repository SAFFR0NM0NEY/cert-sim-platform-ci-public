import { SafeError } from "./errors.ts";
export type RouteId =
  | "eligibility"
  | "current"
  | "currentBindings"
  | "start"
  | "resume"
  | "itemPage"
  | "save"
  | "flags"
  | "flag"
  | "questionIssue"
  | "abandon"
  | "submit"
  | "result"
  | "review"
  | "weakAreaOptions"
  | "practiceAvailability"
  | "practiceStart"
  | "practiceReplace"
  | "practiceCheck"
  | "recoverableSandboxes"
  | "practiceRecover"
  | "lifecycleSummary"
  | "history"
  | "staffHistory"
  | "staffAnalytics"
  | "staffDashboardScope"
  | "staffScopeOptions"
  | "staffDashboardQuery"
  | "staffLearnerDetail"
  | "historySummary"
  | "printSummary"
  | "pythonWorkspaceGet"
  | "pythonWorkspaceSave"
  | "pythonRunRequest"
  | "pythonRunLatest"
  | "pythonRunStatus"
  | "pythonRunCancel";
export interface Route {
  id: RouteId;
  method: string;
  params: Record<string, string>;
  rpc: string;
}
const RPC: Record<RouteId, string> = {
  eligibility: "certsim_protected_check_profile_eligibility",
  current: "certsim_protected_discover_current_formal_attempt",
  currentBindings: "certsim_protected_list_current_attempt_bindings",
  start: "certsim_protected_start_attempt",
  resume: "certsim_protected_resume_attempt",
  itemPage: "certsim_protected_list_attempt_item_page",
  save: "certsim_protected_save_response",
  flags: "certsim_protected_list_flags",
  flag: "certsim_protected_set_flag",
  questionIssue: "certsim_protected_report_question_issue",
  abandon: "certsim_protected_abandon_attempt",
  submit: "certsim_protected_submit_attempt",
  result: "certsim_protected_get_result",
  review: "certsim_protected_get_review",
  weakAreaOptions: "certsim_protected_weak_area_options",
  practiceAvailability: "certsim_protected_practice_availability",
  practiceStart: "certsim_protected_start_practice",
  practiceReplace: "certsim_protected_replace_current_practice_attempt",
  practiceCheck: "certsim_protected_check_practice_item",
  recoverableSandboxes: "certsim_protected_list_recoverable_study_sandboxes",
  practiceRecover: "certsim_protected_recover_study_sandbox",
  lifecycleSummary: "certsim_protected_get_attempt_lifecycle_summary",
  history: "certsim_protected_list_history",
  staffHistory: "certsim_protected_list_staff_history",
  staffAnalytics: "certsim_protected_staff_analytics",
  staffDashboardScope: "certsim_protected_staff_dashboard_scope",
  staffScopeOptions: "certsim_protected_staff_scope_options",
  staffDashboardQuery: "certsim_protected_staff_dashboard_query",
  staffLearnerDetail: "certsim_protected_staff_learner_detail",
  historySummary: "certsim_protected_history_summary",
  printSummary: "certsim_protected_print_summary",
  pythonWorkspaceGet: "certsim_protected_get_python_workspace",
  pythonWorkspaceSave: "certsim_protected_save_python_workspace",
  pythonRunRequest: "certsim_protected_request_python_run",
  pythonRunLatest: "certsim_protected_get_latest_python_run",
  pythonRunStatus: "certsim_protected_get_python_run",
  pythonRunCancel: "certsim_protected_cancel_python_run",
};
export function matchRoute(request: Request): Route {
  const url = new URL(request.url);
  const marker = "/certsim-protected-exam";
  const offset = url.pathname.indexOf(marker);
  let path = offset >= 0
    ? url.pathname.slice(offset + marker.length)
    : url.pathname;
  path = `/${path.split("/").filter(Boolean).join("/")}`;
  if (path === "/") path = "/";
  const candidates: Array<[RouteId, string, RegExp, string[]]> = [
    ["weakAreaOptions", "GET", /^\/practice\/weak-areas$/, []],
    ["practiceAvailability", "GET", /^\/practice\/availability$/, []],
    ["practiceStart", "POST", /^\/practice\/sessions$/, []],
    ["practiceReplace", "POST", /^\/practice\/sessions\/replace$/, []],
    ["recoverableSandboxes", "GET", /^\/practice\/recoverable-sandboxes$/, []],
    ["practiceRecover", "POST", /^\/practice\/sessions\/([^/]+)\/recover$/, ["attemptId"]],
    ["practiceCheck", "POST", /^\/practice\/sessions\/([^/]+)\/items\/([^/]+)\/check$/, ["attemptId", "itemId"]],
    ["historySummary", "GET", /^\/history\/summary$/, []],
    ["history", "GET", /^\/history$/, []],
    ["staffHistory", "GET", /^\/staff\/history$/, []],
    ["staffAnalytics", "GET", /^\/staff\/analytics$/, []],
    ["staffDashboardScope", "GET", /^\/staff\/dashboard-scope$/, []],
    ["staffScopeOptions", "GET", /^\/staff\/scope-options$/, []],
    ["staffDashboardQuery", "GET", /^\/staff\/dashboard-query$/, []],
    ["staffLearnerDetail", "GET", /^\/staff\/learner-detail$/, []],
    ["printSummary", "GET", /^\/attempts\/([^/]+)\/print-summary$/, ["attemptId"]],
    ["lifecycleSummary", "GET", /^\/attempts\/([^/]+)\/lifecycle-summary$/, ["attemptId"]],
    ["pythonWorkspaceGet", "GET", /^\/attempts\/([^/]+)\/items\/([^/]+)\/python\/workspace$/, ["attemptId", "itemId"]],
    ["pythonWorkspaceSave", "PUT", /^\/attempts\/([^/]+)\/items\/([^/]+)\/python\/workspace$/, ["attemptId", "itemId"]],
    ["pythonRunRequest", "POST", /^\/attempts\/([^/]+)\/items\/([^/]+)\/python\/runs$/, ["attemptId", "itemId"]],
    ["pythonRunLatest", "GET", /^\/attempts\/([^/]+)\/items\/([^/]+)\/python\/runs\/latest$/, ["attemptId", "itemId"]],
    ["pythonRunStatus", "GET", /^\/attempts\/([^/]+)\/items\/([^/]+)\/python\/runs\/([^/]+)$/, ["attemptId", "itemId", "runId"]],
    ["pythonRunCancel", "POST", /^\/attempts\/([^/]+)\/items\/([^/]+)\/python\/runs\/([^/]+)\/cancel$/, ["attemptId", "itemId", "runId"]],
    ["eligibility", "GET", /^\/eligibility$/, []],
    ["current", "GET", /^\/attempts\/current$/, []],
    ["currentBindings", "GET", /^\/attempts\/current-bindings$/, []],
    ["start", "POST", /^\/attempts$/, []],
    ["itemPage", "GET", /^\/attempts\/([^/]+)\/items$/, ["attemptId"]],
    ["save", "PUT", /^\/attempts\/([^/]+)\/items\/([^/]+)\/response$/, [
      "attemptId",
      "itemId",
    ]],
    ["flags", "GET", /^\/attempts\/([^/]+)\/flags$/, ["attemptId"]],
    ["flag", "PUT", /^\/attempts\/([^/]+)\/items\/([^/]+)\/flag$/, ["attemptId", "itemId"]],
    ["questionIssue", "POST", /^\/attempts\/([^/]+)\/items\/([^/]+)\/issue$/, ["attemptId", "itemId"]],
    ["abandon", "POST", /^\/attempts\/([^/]+)\/abandon$/, ["attemptId"]],
    ["submit", "POST", /^\/attempts\/([^/]+)\/submit$/, ["attemptId"]],
    ["result", "GET", /^\/attempts\/([^/]+)\/result$/, ["attemptId"]],
    ["review", "GET", /^\/attempts\/([^/]+)\/review$/, ["attemptId"]],
    ["resume", "GET", /^\/attempts\/([^/]+)$/, ["attemptId"]],
  ];
  const pathMatches = candidates.filter(([, , pattern]) => pattern.test(path));
  const found = pathMatches.find(([, method]) => method === request.method);
  if (!found) {
    throw new SafeError(
      pathMatches.length ? "method_not_allowed" : "invalid_request",
      pathMatches.length ? 405 : 404,
    );
  }
  const [id, method, pattern, names] = found;
  const values = path.match(pattern)?.slice(1) ?? [];
  return {
    id,
    method,
    rpc: RPC[id],
    params: Object.fromEntries(
      names.map((name, index) => [name, values[index]]),
    ),
  };
}
