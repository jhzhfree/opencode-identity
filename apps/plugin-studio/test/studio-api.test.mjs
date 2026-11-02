import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("fresh Studio runs independently and protects its AKB management APIs from cross-origin writes", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "identity-studio-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      STUDIO_PORT: String(port),
      STUDIO_STATE_FILE: path.join(temp, "jobs.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(
    () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill();
      }),
  );
  let logs = "";
  child.stderr.on("data", (b) => (logs += b));
  child.stdout.on("data", (b) => (logs += b));
  const base = `http://127.0.0.1:${port}`;
  let status;
  for (let i = 0; i < 100; i++) {
    try {
      status = await fetch(base + "/api/status");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(status?.ok, logs);
  assert.equal((await status.json()).lab.found, true);
  const blocked = await fetch(base + "/api/akb/build", {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(blocked.status, 403);
  const plain = await fetch(base + "/api/akb/build", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(plain.status, 415);
  const workspace = path.join(temp, "work");
  await mkdir(workspace, { mode: 0o700 });
  const build = await fetch(base + "/api/akb/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace,
      dataDir: path.join(temp, "secure"),
      agents: ["build"],
      serverUrl: "https://kb.example",
      opencodeMajor: "2",
    }),
  });
  assert.equal(build.status, 200);
  const { jobId } = await build.json();
  let job;
  // Generation writes every file through owner-only ACL hardening, which costs
  // ~1s per file on Windows; wait long enough for a real build to finish.
  for (let i = 0; i < 400; i++) {
    job = await (await fetch(base + "/api/jobs/" + jobId)).json();
    if (job.state !== "running") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(job.state, "done", job.error);
  assert.equal(job.progress,100);
  assert.equal(job.steps.length,6);
  assert.ok(job.steps.every(step=>step.status==="done"));
  assert.equal(job.result.target, "akb");
  assert.equal(job.result.zip, undefined);
  const enrollment=await fetch(base+'/api/akb/enrollment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId,agentName:'build'})});
  assert.equal(enrollment.status,200);
  const publicData=await enrollment.json();
  assert.equal(publicData.uuid,job.result.agents[0].uuid);
  assert.ok(publicData.publicJwk.n);
  assert.equal(publicData.publicJwk.d,undefined);
  const checking=await fetch(base+'/api/akb/check/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId,agentName:'build'})});
  assert.equal(checking.status,200);
  const checkId=(await checking.json()).jobId;
  let checked;
  for(let i=0;i<100;i++){
    checked=await(await fetch(base+'/api/jobs/'+checkId)).json();
    if(checked.state!=='running')break;
    await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(checked.state,'done');
  assert.equal(checked.result.ok,false);
  assert.equal(checked.result.checks[0].status,'failed');
  assert.ok(checked.logs.length>0);
  const download = await fetch(base + "/api/download/" + jobId);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/zip");
  assert.ok(
    !Buffer.from(await download.arrayBuffer()).includes(
      Buffer.from("BEGIN PRIVATE KEY"),
    ),
  );
});
