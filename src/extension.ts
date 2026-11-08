import * as vscode from 'vscode';
import type { API, GitExtension, Repository } from './git';

const running = new Set<string>();

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');

	if (!gitExtension) { return; }

	let git: API;
	try {
		const gitApiProvider = gitExtension.isActive
			? gitExtension.exports
			: await gitExtension.activate();
		git = gitApiProvider.getAPI(1);
	} catch (error) {
		console.error('[project-git-pull] Failed to activate Git extension:', error);
		return;
	}

	const syncAll = (manual: boolean): void => {
		if (manual && git.repositories.length === 0) {
			void vscode.window.showInformationMessage('No Git repositories found in the workspace.');
			return;
		}
		for (const repo of git.repositories) {
			void syncRepo(repo, manual);
		}
	};

	syncAll(false);

	context.subscriptions.push(
		git.onDidOpenRepository((repo) => void syncRepo(repo, false)),
		vscode.commands.registerCommand('project-git-pull.syncNow', () => syncAll(true))
	);
}

async function syncRepo(repo: Repository, manual: boolean): Promise<void> {
	const key = repo.rootUri.toString();
	if (running.has(key)) { return; }

	running.add(key);

	try {
		await runSync(repo, manual);
	} catch (error) {
		void vscode.window.showErrorMessage(`Project Git Pull: ${errorMessage(error)}`);
	} finally {
		running.delete(key);
	}
}

async function runSync(repo: Repository, manual: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('projectGitPull');
  const target = config.get<string>('branch', 'develop');
  const mode = config.get<string>('mode', 'ask');
 
  // 1. Preuzmi najnovije podatke sa remote-a i osveži status.
  try {
    await repo.fetch();
    await repo.status();
  } catch (err) {
    // Najčešće: nema interneta ili kredencijala. Pri startu ćutimo.
    console.error('[project-git-pull] fetch failed:', err);
    if (manual) {
      void vscode.window.showWarningMessage(`Project Git Pull: fetch failed — ${errorMessage(err)}`);
    }
    return;
  }
 
  const head = repo.state.HEAD;
  if (!head?.name) {
    return; // detached HEAD
  }
 
  const isDirty =
    repo.state.workingTreeChanges.length > 0 ||
    repo.state.indexChanges.length > 0 ||
    repo.state.mergeChanges.length > 0;
 
  // 2. Nisi na timskoj grani: ponudi prelazak (samo ako nemaš nekomitovanih izmena).
  if (head.name !== target) {
    if (isDirty) {
      return;
    }
    offer(
      `You are on "${head.name}", but the team works on "${target}".`,
      `Switch to ${target} and pull`,
      () => switchAndPull(repo, target)
    );
    return;
  }
 
  // 3. Na timskoj si grani: proveri da li zaostaješ za remote-om.
  const behind = head.behind ?? 0;
  if (behind === 0) {
    if (manual) {
      void vscode.window.showInformationMessage(`Project Git Pull: "${target}" is already up to date.`);
    }
    return;
  }
 
  if (isDirty) {
    void vscode.window.showWarningMessage(
      `Project Git Pull: ${behind} new commit(s) on "${target}", but you have uncommitted changes — pull skipped.`
    );
    return;
  }
 
  // Ako imaš lokalne commit-ove koji nisu push-ovani, pull može da napravi merge,
  // zato u tom slučaju uvek pitamo, čak i u "auto" režimu.
  const hasUnpushedCommits = (head.ahead ?? 0) > 0;
  if (mode === 'auto' && !hasUnpushedCommits) {
    await pull(repo, target);
    return;
  }
 
  const note = hasUnpushedCommits ? ' (you also have local commits that are not pushed)' : '';
  offer(`${behind} new commit(s) on "${target}"${note}.`, 'Pull', () => pull(repo, target));
}
 
async function switchAndPull(repo: Repository, target: string): Promise<void> {
  try {
    await repo.checkout(target);
  } catch (err) {
    void vscode.window.showErrorMessage(`Project Git Pull: checkout of "${target}" failed — ${errorMessage(err)}`);
    return;
  }
  await pull(repo, target);
}
 
async function pull(repo: Repository, target: string): Promise<void> {
  try {
    await repo.pull();
    vscode.window.setStatusBarMessage(`Project Git Pull: "${target}" is up to date.`, 5000);
  } catch (err) {
    void vscode.window.showErrorMessage(`Project Git Pull: pull failed — ${errorMessage(err)}`);
  }
}
 
// Prikazuje notifikaciju sa jednim dugmetom, bez čekanja da korisnik odgovori,
// kako se sinhronizacija ne bi "zaglavila" dok je notifikacija otvorena.
function offer(message: string, label: string, action: () => Promise<void>): void {
  void vscode.window.showInformationMessage(message, label).then((choice) => {
    if (choice === label) {
      void action();
    }
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// This method is called when your extension is deactivated
export function deactivate(): void {}
