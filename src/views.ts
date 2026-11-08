import * as vscode from 'vscode';
import type { Repository } from './git';

export const REPOS_VIEW_ID = 'projectGitPull.repositories';
export const ACTIVITY_VIEW_ID = 'projectGitPull.activity';

export type Level = 'info' | 'success' | 'warning' | 'error';

// ======================= Activity =======================

export interface ActivityEntry {
	time: Date;
	level: Level;
	message: string;
}

const MAX_ENTRIES = 100;

// Lista događaja (najnoviji na vrhu). Ovde završava sve što bi inače bilo
// u statusnoj liniji ili u notifikacijama.
export class ActivityProvider implements vscode.TreeDataProvider<ActivityEntry> {
	private entries: ActivityEntry[] = [];
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	add(level: Level, message: string): void {
		this.entries.unshift({ time: new Date(), level, message });
		if (this.entries.length > MAX_ENTRIES) {
			this.entries.length = MAX_ENTRIES;
		}
		this.emitter.fire();
	}

	clear(): void {
		this.entries = [];
		this.emitter.fire();
	}

	getTreeItem(entry: ActivityEntry): vscode.TreeItem {
		const item = new vscode.TreeItem(entry.message, vscode.TreeItemCollapsibleState.None);
		item.description = entry.time.toLocaleTimeString();
		item.tooltip = `${entry.time.toLocaleString()}\n${entry.message}`;
		item.iconPath = levelIcon(entry.level);
		return item;
	}

	getChildren(element?: ActivityEntry): ActivityEntry[] {
		return element ? [] : this.entries;
	}
}

function levelIcon(level: Level): vscode.ThemeIcon {
	switch (level) {
		case 'success':
			return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
		case 'warning':
			return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
		case 'error':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
		default:
			return new vscode.ThemeIcon('info');
	}
}

// ======================= Repositories =======================

export interface RepoMeta {
	repo: Repository;
	name: string;
	busy?: string; // npr. "fetching…" dok traje operacija
	lastChecked?: Date;
	listener?: vscode.Disposable;
}

export type RepoNode =
	| { kind: 'repo'; meta: RepoMeta }
	| { kind: 'detail'; label: string; value: string; icon: string };

export function uncommittedCount(repo: Repository): number {
	return (
		repo.state.workingTreeChanges.length +
		repo.state.indexChanges.length +
		repo.state.mergeChanges.length
	);
}

export function isDirty(repo: Repository): boolean {
	return uncommittedCount(repo) > 0;
}

export interface RepoStatus {
	summary: string;
	icon: vscode.ThemeIcon;
	// Određuje koja dugmad se prikazuju pored repozitorijuma (vidi menus u package.json).
	context: 'repo' | 'repo.behind' | 'repo.offTarget';
	// Da li repozitorijum traži tvoju pažnju (računa se u značku na ikoni).
	attention: boolean;
}

export function getRepoStatus(meta: RepoMeta, target: string): RepoStatus {
	const warning = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));

	if (meta.busy) {
		return { summary: meta.busy, icon: new vscode.ThemeIcon('sync~spin'), context: 'repo', attention: false };
	}

	const head = meta.repo.state.HEAD;
	if (!head?.name) {
		return { summary: 'detached HEAD', icon: warning, context: 'repo', attention: false };
	}

	const dirty = isDirty(meta.repo);

	if (head.name !== target) {
		return {
			summary: `not on "${target}"`,
			icon: warning,
			context: dirty ? 'repo' : 'repo.offTarget',
			attention: true
		};
	}

	if (!head.upstream) {
		return { summary: 'no upstream branch', icon: warning, context: 'repo', attention: false };
	}

	const behind = head.behind ?? 0;
	if (behind > 0) {
		return {
			summary: `${behind} commit(s) behind`,
			icon: new vscode.ThemeIcon('arrow-down', new vscode.ThemeColor('charts.blue')),
			context: dirty ? 'repo' : 'repo.behind',
			attention: true
		};
	}

	return {
		summary: 'up to date',
		icon: new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')),
		context: 'repo',
		attention: false
	};
}

export class RepositoriesProvider implements vscode.TreeDataProvider<RepoNode> {
	private readonly items = new Map<string, RepoMeta>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly getTarget: () => string) { }

	add(repo: Repository, name: string): RepoMeta {
		const key = repo.rootUri.toString();
		const existing = this.items.get(key);
		if (existing) {
			return existing;
		}
		const meta: RepoMeta = { repo, name };
		this.items.set(key, meta);
		return meta;
	}

	remove(repo: Repository): void {
		const key = repo.rootUri.toString();
		this.items.get(key)?.listener?.dispose();
		this.items.delete(key);
	}

	all(): RepoMeta[] {
		return [...this.items.values()];
	}

	attentionCount(): number {
		const target = this.getTarget();
		return this.all().filter((meta) => getRepoStatus(meta, target).attention).length;
	}

	refresh(): void {
		this.emitter.fire();
	}

	getTreeItem(node: RepoNode): vscode.TreeItem {
		if (node.kind === 'detail') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.description = node.value;
			item.tooltip = `${node.label}: ${node.value}`;
			item.iconPath = new vscode.ThemeIcon(node.icon);
			return item;
		}

		const { meta } = node;
		const status = getRepoStatus(meta, this.getTarget());
		const head = meta.repo.state.HEAD;

		const item = new vscode.TreeItem(meta.name, vscode.TreeItemCollapsibleState.Expanded);
		item.id = meta.repo.rootUri.toString(); // čuva stanje (otvoreno/zatvoreno) pri osvežavanju
		item.description = `${head?.name ?? 'detached HEAD'} · ${status.summary}`;
		item.tooltip = meta.repo.rootUri.fsPath;
		item.iconPath = status.icon;
		item.contextValue = status.context;
		return item;
	}

	getChildren(node?: RepoNode): RepoNode[] {
		if (!node) {
			return this.all().map((meta): RepoNode => ({ kind: 'repo', meta }));
		}
		if (node.kind === 'detail') {
			return [];
		}
		return detailRows(node.meta, this.getTarget());
	}
}

function detailRows(meta: RepoMeta, target: string): RepoNode[] {
	const head = meta.repo.state.HEAD;
	const changes = uncommittedCount(meta.repo);

	const branch = head?.name
		? head.name === target
			? head.name
			: `${head.name} (team branch: ${target})`
		: 'detached HEAD';

	const upstream = head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : 'none';
	const position = head?.upstream
		? `${head.behind ?? 0} behind · ${head.ahead ?? 0} ahead`
		: 'n/a';

	const rows: Array<[string, string, string]> = [
		['Branch', branch, 'git-branch'],
		['Upstream', upstream, 'cloud'],
		['Behind / ahead', position, 'arrow-swap'],
		['Working tree', changes > 0 ? `${changes} uncommitted change(s)` : 'clean', 'edit'],
		['Last checked', meta.lastChecked ? meta.lastChecked.toLocaleTimeString() : 'not yet', 'history']
	];

	return rows.map(([label, value, icon]): RepoNode => ({ kind: 'detail', label, value, icon }));
}