// Запасной будильник для часового обновления сайта. Расписание GitHub Actions может
// опаздывать на час или пропускать запуски, поэтому воркер раз в час смотрит, когда
// последний раз запускался update.yml, и запускает его сам, если давно не было.
// Нужен секрет GH_DISPATCH_TOKEN: токен GitHub с правом Actions: Read and write на репозиторий.

const WORKFLOW = "update.yml";
export const STALE_MINUTES = 50;

function github(env) {
  const headers = {
    Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "vacante-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return { api: `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}`, headers };
}

// Запустить обновление сайта сейчас (например, когда модератор одобрил вакансию)
export async function dispatchUpdate(env, fetchFn = fetch) {
  const { api, headers } = github(env);
  const r = await fetchFn(`${api}/dispatches`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!r.ok) throw new Error(`GitHub dispatch: ${r.status}`);
}

export async function wakeUpdate(env, now = Date.now(), fetchFn = fetch) {
  if (!env.GH_DISPATCH_TOKEN) return "no-token";
  const { api, headers } = github(env);
  const runs = await fetchFn(`${api}/runs?per_page=1`, { headers });
  if (!runs.ok) throw new Error(`GitHub runs: ${runs.status}`);
  const last = (await runs.json()).workflow_runs?.[0];
  if (last && now - Date.parse(last.created_at) < STALE_MINUTES * 60_000) return "recent";
  await dispatchUpdate(env, fetchFn);
  return "dispatched";
}
