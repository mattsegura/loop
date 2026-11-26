// Start a local task in the project's linked folder without changing the hub's cwd.
import { basename } from 'node:path';
import { TaskStore } from '../lib/tasks.mjs';
import { spawn } from 'node:child_process';
import { ProjectFolders } from '../lib/project-folders.mjs';
import { defaultDataDir, LoopStore } from '../lib/store.mjs';

const [project, separator, command, ...args] = process.argv.slice(2);
try {
  if (!project || separator !== '--' || !command) throw Error('Usage: npm run project:exec -- <project-id> -- <command> [args...]');
  const dir = defaultDataDir();
  if (!await new LoopStore(dir).getProfile(project)) throw Error('Named project not found.');
  const cwd = await new ProjectFolders(dir).resolve(project);
  if (!cwd) throw Error('No local checkout is available for this project. Attach its folder first.');
  // Never include command arguments, environment values, or output in shared task history.
  const history = new TaskStore(dir);
  const opts = { profile: project, writtenBy: 'Local launcher' };
  const { task } = await history.save({ title: 'Run ' + basename(command).slice(0, 80), expectedRevision: 0 }, opts);
  let outcome = { code: 1, signal: null };
  try {
    const child = spawn(command, args, { cwd, env: { ...process.env, LOOP_HUB_PROJECT: project }, stdio: 'inherit', shell: false });
    outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await history.save({ id: task.id, expectedRevision: task.revision, status: outcome.code === 0 ? 'completed' : 'waiting',
      notes: outcome.signal ? 'Stopped by signal ' + outcome.signal : 'Exit code: ' + outcome.code }, opts);
  }
  if (outcome.signal) process.kill(process.pid, outcome.signal); else process.exitCode = outcome.code ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
