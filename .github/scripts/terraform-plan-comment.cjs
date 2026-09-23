// Publishes the Terraform plan for infra/terraform/platform to the job summary and to a single
// pull request comment that is updated on every push. Called from ci.yml via actions/github-script.
// Inputs (env): PLAN_FILE (plan text), PLAN_EXIT_CODE (terraform plan -detailed-exitcode result).
const fs = require("node:fs");

const MARKER = "<!-- italy-planner-terraform-plan -->";
// Decision: GitHub rejects comment bodies over 65,536 characters. Keeping the plan at 60,000
// leaves room for the header, fences and the truncation note.
const COMMENT_PLAN_LIMIT = 60000;
// Decision: the job summary allows 1 MiB per step. Stay well under it.
const SUMMARY_PLAN_LIMIT = 500000;
// The end of a plan carries the "Plan: N to add" line or the error, so it is always kept.
const TAIL_CHARS = 4000;

function statusLabel(exitCode) {
  if (exitCode === "0") return "No changes";
  if (exitCode === "2") return "Changes to apply";
  return "Plan failed";
}

// Keeps the head and the tail of a long plan and says how much was dropped in between.
function truncate(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit - TAIL_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n... ${omitted} characters omitted, full plan in the job log ...\n\n${tail}`;
}

// A fence one backtick longer than any run inside the plan, so plan text can never close it.
function fenceFor(text) {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function render({ plan, exitCode, sha, runUrl }) {
  const fence = fenceFor(plan);
  return [
    MARKER,
    "### Terraform plan: infra/terraform/platform",
    "",
    `**${statusLabel(exitCode)}** for commit \`${sha.slice(0, 7)}\` ([run log](${runUrl}))`,
    "",
    "<details><summary>Show plan</summary>",
    "",
    `${fence}text`,
    plan.trimEnd(),
    fence,
    "",
    "</details>",
  ].join("\n");
}

async function upsertComment({ github, context, body }) {
  const { owner, repo } = context.repo;
  const issue_number = context.payload.pull_request.number;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(MARKER),
  );
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return;
  }
  await github.rest.issues.createComment({ owner, repo, issue_number, body });
}

module.exports = async function publish({ github, context, core }) {
  const raw = fs.readFileSync(process.env.PLAN_FILE, "utf8");
  const exitCode = process.env.PLAN_EXIT_CODE ?? "";
  const sha = context.payload.pull_request?.head?.sha ?? context.sha;
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const facts = { exitCode, sha, runUrl };

  await core.summary.addRaw(render({ ...facts, plan: truncate(raw, SUMMARY_PLAN_LIMIT) })).write();
  await upsertComment({
    github,
    context,
    body: render({ ...facts, plan: truncate(raw, COMMENT_PLAN_LIMIT) }),
  });
};
