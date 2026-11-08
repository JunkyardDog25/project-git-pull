import * as vscode from 'vscode';
import type { API, GitExtension, Repository } from './git';
import {
	ACTIVITY_VIEW_ID,
	ActivityProvider,
	REPOS_VIEW_ID,
	RepositoriesProvider,
	isDirty,
	type Level,
	type RepoMeta,
	type RepoNode
} from './views';

const SHOW_ACTIVITY = 'Show Activity';
const OPEN_SCM = 'Open Source Control';
// VS Code automatski pravi ovu komandu za svaki view container (id iz package.json).
const SHOW_SIDEBAR_COMMAND = 'workbench.view.extension.projectGitPull';

type PopupLevel = Exclude<Level, 'success'>;
type Action = { label: string; run: () => unknown };

// Repozitorijumi koji se trenutno sinhronizuju (sprečava dupla pokretanja).
const running = new Set<string>();

let output: vscode.OutputChannel;
let activity: ActivityProvider;
let repos: RepositoriesProvider;
let repoTree: vscode.TreeView<RepoNode>;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel('Project Git Pull');
	activity = new ActivityProvider();
	repos = new RepositoriesProvider(getTargetBranch);
	repoTree = vscode.window.createTreeView<RepoNode>(REPOS_VIEW_ID, { treeDataProvider: repos });

	context.subscriptions.push(
		output,
		repoTree,
		vscode.window.registerTreeDataProvider(ACTIVITY_VIEW_ID, activity),
		vscode.commands.registerCommand('project-git-pull.syncNow', async () => {
			await vscode.commands.executeCommand(SHOW_SIDEBAR_COMMAND);
			for (const meta of repos.all()) {
				void syncRepo(meta);
			}
		}),
		vscode.commands.registerCommand('project-git-pull.pull', (node?: RepoNode) => {
			if (node?.kind === 'repo') {
				void pull(node.meta);
			}
		}),
		vscode.commands.registerCommand('project-git-pull.switchAndPull', (node?: RepoNode) => {
			if (node?.kind === 'repo') {
				void switchAndPull(node.meta, getTargetBranch());
			}
		}),
		vscode.commands.registerCommand('project-git-pull.clearActivity', () => activity.clear()),
		vscode.commands.registerCommand('project-git-pull.showOutput', () => output.show(true)),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('projectGitPull')) {
				refreshViews();
			}
		}),
		{
			dispose: () => {
				clearTimeout(refreshTimer);
				repos.all().forEach((meta) => meta.listener?.dispose());
			}
		}
	);

	log('Extension activated.');

	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExtension) {
		report('error', 'Built-in Git extension (vscode.git) was not found.');
		return;
	}

	let git: API;
	try {
		const gitApiProvider = gitExtension.isActive
			? gitExtension.exports
			: await gitExtension.activate();
		git = gitApiProvider.getAPI(1);
	} catch (error) {
		notify('error', `Failed to activate the Git extension — ${errorMessage(error)}`);
		return;
	}

	// Počni da pratiš repozitorijum: osvežava prikaz kad god se njegovo stanje promeni
	// (npr. kad ti commit-uješ ili povučeš izmene ručno).
	const track = (repo: Repository): RepoMeta => {
		const meta = repos.add(repo, repoName(repo));
		meta.listener ??= repo.state.onDidChange(scheduleRefresh);
		refreshViews();
		return meta;
	};

	for (const repo of git.repositories) {
		void syncRepo(track(repo));
	}

	context.subscriptions.push(
		// Repozitorijumi koji se učitaju kasnije (git ekstenzija ih ponekad otkrije sa zakašnjenjem).
		git.onDidOpenRepository((repo) => {
			log(`Repository opened: ${repoName(repo)}`);
			void syncRepo(track(repo));
		}),
		git.onDidCloseRepository((repo) => {
			repos.remove(repo);
			refreshViews();
		})
	);
}

export function deactivate(): void { }

// ======================= Sinhronizacija =======================

async function syncRepo(meta: RepoMeta): Promise<void> {
	const key = meta.repo.rootUri.toString();
	if (running.has(key) || meta.busy) {
		log(`${meta.name}: an operation is already in progress, skipping sync.`);
		return;
	}

	running.add(key);
	try {
		await runSync(meta);
	} catch (error) {
		notify('error', `${meta.name}: ${errorMessage(error)}`);
	} finally {
		running.delete(key);
	}
}

async function runSync(meta: RepoMeta): Promise<void> {
	const { repo, name } = meta;
	const config = vscode.workspace.getConfiguration('projectGitPull');
	const target = getTargetBranch();
	const mode = config.get<string>('mode', 'ask');

	log(`${name}: starting sync (target branch "${target}", mode "${mode}").`);

	// 1. Preuzmi najnovije podatke sa remote-a i osveži status.
	try {
		await withBusy(meta, 'fetching…', async () => {
			await repo.fetch();
			await repo.status();
			meta.lastChecked = new Date();
		});
	} catch (error) {
		// Najčešće: nema interneta ili kredencijala.
		report('warning', `${name}: could not fetch (offline or no access?) — ${errorMessage(error)}`);
		return;
	}

	const head = repo.state.HEAD;
	if (!head?.name) {
		report('info', `${name}: HEAD is detached, nothing to sync.`);
		return;
	}

	const dirty = isDirty(repo);

	log(
		`${name}: on "${head.name}", upstream ${head.upstream ? `"${head.upstream.remote}/${head.upstream.name}"` : 'none'}, ` +
		`ahead ${head.ahead ?? 0}, behind ${head.behind ?? 0}, uncommitted changes: ${dirty ? 'yes' : 'no'}.`
	);

	// 2. Nisi na timskoj grani: ponudi prelazak (samo ako nemaš nekomitovanih izmena).
	if (head.name !== target) {
		if (dirty) {
			report(
				'info',
				`${name}: you are on "${head.name}" (not "${target}") and have uncommitted changes, so switching is not offered.`
			);
			return;
		}
		notify(
			'info',
			`${name}: you are on "${head.name}", but the team works on "${target}".`,
			[{ label: `Switch to ${target} and pull`, run: () => switchAndPull(meta, target) }]
		);
		return;
	}

	// 3. Na timskoj si grani: bez upstream-a nema poređenja sa remote-om.
	if (!head.upstream) {
		report(
			'warning',
			`${name}: branch "${head.name}" has no upstream branch, so it can't be compared with the remote. ` +
			`Fix it with: git branch --set-upstream-to=origin/${head.name}`
		);
		return;
	}

	// 4. Proveri da li zaostaješ za remote-om.
	const behind = head.behind ?? 0;
	if (behind === 0) {
		report('success', `${name}: "${target}" is up to date.`);
		return;
	}

	if (dirty) {
		notify(
			'warning',
			`${name}: ${behind} new commit(s) on "${target}", but you have uncommitted changes — pull skipped.`,
			[{ label: OPEN_SCM, run: () => vscode.commands.executeCommand('workbench.view.scm') }]
		);
		return;
	}

	// Ako imaš lokalne commit-ove koji nisu push-ovani, pull može da napravi merge,
	// zato u tom slučaju uvek pitamo, čak i u "auto" režimu.
	const hasUnpushedCommits = (head.ahead ?? 0) > 0;
	if (mode === 'auto' && !hasUnpushedCommits) {
		await pull(meta);
		return;
	}

	const note = hasUnpushedCommits ? ' (you also have local commits that are not pushed)' : '';
	notify(
		'info',
		`${name}: ${behind} new commit(s) on "${target}"${note}.`,
		[{ label: 'Pull', run: () => pull(meta) }]
	);
}

async function switchAndPull(meta: RepoMeta, target: string): Promise<void> {
	const { repo, name } = meta;
	if (meta.busy) {
		report('info', `${name}: another operation is in progress, try again in a moment.`);
		return;
	}

	try {
		await withBusy(meta, 'switching…', async () => {
			await repo.checkout(target);
			await repo.status();
		});
	} catch (error) {
		notify('error', `${name}: could not switch to "${target}" — ${errorMessage(error)}`);
		return;
	}

	log(`${name}: switched to "${target}".`);
	const behind = repo.state.HEAD?.behind ?? 0;
	if (behind === 0) {
		report('success', `${name}: switched to "${target}", it is already up to date.`);
		return;
	}
	await pull(meta, true);
}

// Broj commit-ova i naziv grane čita u trenutku izvršavanja, jer su podaci iz
// notifikacije mogli u međuvremenu da zastare.
async function pull(meta: RepoMeta, switched = false): Promise<void> {
	const { repo, name } = meta;
	if (meta.busy) {
		report('info', `${name}: another operation is in progress, try again in a moment.`);
		return;
	}

	const head = repo.state.HEAD;
	const branch = head?.name ?? getTargetBranch();
	const behind = head?.behind ?? 0;
	if (behind === 0) {
		report('success', `${name}: "${branch}" is already up to date, nothing to pull.`);
		return;
	}

	try {
		await withBusy(meta, 'pulling…', async () => {
			await repo.pull();
			await repo.status();
			meta.lastChecked = new Date();
		});

		const commit = repo.state.HEAD?.commit?.slice(0, 7);
		const what = switched
			? `switched to "${branch}" and pulled ${behind} new commit(s)`
			: `pulled ${behind} new commit(s) on "${branch}"`;
		report('success', `${name}: ${what}${commit ? ` (now at ${commit})` : ''}.`);
	} catch (error) {
		// Npr. merge konflikt ili odbijen pull zbog lokalnih izmena.
		notify('error', `${name}: pull failed — ${errorMessage(error)}`, [
			{ label: OPEN_SCM, run: () => vscode.commands.executeCommand('workbench.view.scm') }
		]);
	}
}

// ======================= Prikaz i obaveštenja =======================

function getTargetBranch(): string {
	return vscode.workspace.getConfiguration('projectGitPull').get<string>('branch', 'develop');
}

// Označava repozitorijum kao zauzet (vrteća ikonica u pogledu) dok traje operacija.
async function withBusy<T>(meta: RepoMeta, text: string, task: () => Thenable<T>): Promise<T> {
	meta.busy = text;
	refreshViews();
	try {
		return await vscode.window.withProgress({ location: { viewId: REPOS_VIEW_ID } }, () => task());
	} finally {
		meta.busy = undefined;
		refreshViews();
	}
}

function refreshViews(): void {
	repos.refresh();
	// Značka na ikoni u Activity Bar-u: broj repozitorijuma koji traže tvoju pažnju.
	const count = repos.attentionCount();
	repoTree.badge = count > 0
		? { value: count, tooltip: `${count} ${count === 1 ? 'repository needs' : 'repositories need'} attention` }
		: undefined;
}

// Git ekstenzija javlja promene stanja često (npr. pri svakom čuvanju fajla),
// pa osvežavanje malo odlažemo.
function scheduleRefresh(): void {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(refreshViews, 300);
}

// Samo u Output kanal (detalji za debagovanje).
function log(message: string): void {
	output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// Događaj ide u "Activity" pogled i u Output kanal, bez skočnog prozora.
function report(level: Level, message: string): void {
	log(`${level.toUpperCase()}: ${message}`);
	activity.add(level, message);
}

// Isto kao report, ali dodatno prikazuje skočnu poruku. Koristi se samo kada treba
// da doneseš odluku (dugmad) ili kada je nešto pošlo naopako.
// Ne čeka odgovor, kako se sinhronizacija ne bi "zaglavila" dok je poruka otvorena.
function notify(level: PopupLevel, message: string, actions: Action[] = []): void {
	report(level, message);

	const all: Action[] = [...actions];
	if (level !== 'info') {
		all.push({ label: SHOW_ACTIVITY, run: () => vscode.commands.executeCommand(SHOW_SIDEBAR_COMMAND) });
	}
	const labels = all.map((a) => a.label);
	const text = `Project Git Pull: ${message}`;

	const pending =
		level === 'error'
			? vscode.window.showErrorMessage(text, ...labels)
			: level === 'warning'
				? vscode.window.showWarningMessage(text, ...labels)
				: vscode.window.showInformationMessage(text, ...labels);

	void pending.then((choice) => {
		void all.find((a) => a.label === choice)?.run();
	});
}

function repoName(repo: Repository): string {
	return repo.rootUri.path.split('/').filter(Boolean).pop() ?? repo.rootUri.fsPath;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}