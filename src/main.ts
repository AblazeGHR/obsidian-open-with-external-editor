import { Plugin, TFile, TFolder, TAbstractFile, Notice, Menu, MarkdownView, FileSystemAdapter, WorkspaceLeaf, PluginSettingTab, Setting, App } from "obsidian";
import type { Hotkey, Modifier } from "obsidian";
import { spawn, execFile } from "child_process";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface Opener {
	id: string;
	/** Label shown in the context menu, e.g. "Open in VSCode". */
	name: string;
	/** Executable or command, e.g. `code` or an absolute path to `code.cmd`. */
	command: string;
	/**
	 * Arguments, one token per line. Supported placeholders:
	 *   {path}  absolute path of the file/folder (always available)
	 *   {line}  1-based cursor line in Obsidian (empty for folders / files not open)
	 *   {col}   1-based cursor column in Obsidian (empty for folders / files not open)
	 * Place a flag (e.g. `-g`) on the line directly ABOVE the token that uses
	 * {line}/{col}; both are dropped automatically when line/col is unavailable
	 * (so folders and closed files still open normally).
	 */
	args: string;
	/**
	 * Optional keyboard shortcut for this opener, e.g. `Ctrl+Shift+O`.
	 * Separate multiple shortcuts with a comma. Accepted modifiers:
	 * `Ctrl`, `Cmd`/`Meta`, `Alt`/`Option`, `Shift`, `Mod` (Ctrl on
	 * Windows/Linux, Cmd on macOS). Empty for none.
	 */
	hotkey?: string;
}

interface Settings {
	openers: Opener[];
}

const DEFAULT_OPENERS: Opener[] = [
	{
		id: "vscode",
		name: "Open in VSCode",
		command: "code",
		// `-g` is dropped for folders / unopened files, leaving a plain `code {path}`.
		args: "-g\n{path}:{line}:{col}",
	},
];

function uid(): string {
	return Math.random().toString(36).slice(2, 10);
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
	mod: "Mod",
	ctrl: "Ctrl",
	control: "Ctrl",
	cmd: "Meta",
	command: "Meta",
	meta: "Meta",
	win: "Meta",
	super: "Meta",
	alt: "Alt",
	option: "Alt",
	opt: "Alt",
	shift: "Shift",
};

/**
 * Parse a user-friendly hotkey string like `Ctrl+Shift+O` or
 * `Mod+O, Ctrl+F5` into Obsidian `Hotkey` objects. Returns null when the
 * input is empty or malformed.
 */
function parseHotkey(input?: string): Hotkey[] | null {
	if (!input) return null;
	const parts = input
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;

	const hotkeys: Hotkey[] = [];
	for (const part of parts) {
		const rawTokens = part.split("+");
		if (rawTokens.some((t) => t.trim() === "")) return null;
		const tokens = rawTokens.map((t) => t.trim());
		const key = tokens[tokens.length - 1];
		if (!key) return null;

		const modifiers: Modifier[] = [];
		for (const m of tokens.slice(0, -1)) {
			const norm = MODIFIER_ALIASES[m.toLowerCase()];
			if (!norm) return null;
			if (!modifiers.includes(norm)) modifiers.push(norm);
		}
		hotkeys.push({
			modifiers,
			key: key.length === 1 ? key.toUpperCase() : key,
		});
	}
	return hotkeys;
}

const hotkeyRefreshTimers = new Map<string, number>();

/** Debounce re-registering an opener's command while the hotkey is being typed. */
function scheduleHotkeyRefresh(plugin: OpenInVSCodePlugin, opener: Opener): void {
	const existing = hotkeyRefreshTimers.get(opener.id);
	if (existing) window.clearTimeout(existing);
	hotkeyRefreshTimers.set(
		opener.id,
		window.setTimeout(() => {
			hotkeyRefreshTimers.delete(opener.id);
			plugin.refreshOpenerCommand(opener);
		}, 300)
	);
}

export default class OpenInVSCodePlugin extends Plugin {
	settings: Settings = { openers: DEFAULT_OPENERS };

	async onload() {
		await this.loadSettings();

		// Context-menu entries, one per configured opener.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
				for (const opener of this.settings.openers) {
					menu.addItem((item) => {
						item
							.setTitle(opener.name || "Open")
							.setIcon("code")
							.onClick(() => this.openWith(opener, file));
					});
				}
			})
		);

		// Command-palette entries: open the currently active file with each opener.
		for (const opener of this.settings.openers) {
			this.registerOpenerCommand(opener);
		}

		this.addSettingTab(new OpenInVSCodeSettingTab(this.app, this));
	}

	onunload() {}

	/** Register (or re-register) the command-palette command for one opener. */
	private registerOpenerCommand(opener: Opener): void {
		const hotkeys = parseHotkey(opener.hotkey);
		this.addCommand({
			id: `open-current-${opener.id}`,
			name: `Open current file in ${opener.name || "external editor"}`,
			hotkeys: hotkeys ?? undefined,
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) {
					new Notice("No active file to open.");
					return;
				}
				this.openWith(opener, view.file);
			},
		});
	}

	/** Re-apply an opener's command so a hotkey change takes effect immediately. */
	refreshOpenerCommand(opener: Opener): void {
		if (!this.settings.openers.includes(opener)) return;
		this.removeOpenerCommand(opener);
		this.registerOpenerCommand(opener);
	}

	/** Remove a dynamically registered opener command (no-op on older Obsidian). */
	removeOpenerCommand(opener: Opener): void {
		if (typeof this.removeCommand === "function") {
			this.removeCommand(`open-current-${opener.id}`);
		}
	}

	private getOpenLeafForFile(file: TFile): WorkspaceLeaf | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			if (view?.file?.path === file.path) return leaf;
		}
		return null;
	}

	private getAbsolutePath(file: TAbstractFile): string {
		const adapter = this.app.vault.adapter as FileSystemAdapter;
		return `${adapter.getBasePath()}/${file.path}`.replace(/\\/g, "/");
	}

	/**
	 * Turn an opener template into a concrete argument list.
	 * - Substitutes {path}/{line}/{col}.
	 * - Drops any token containing {line}/{col} when line/col is unavailable.
	 * - Drops a flag token (starts with `-`) directly above a dropped token.
	 * - Ensures the path is always present (appends it if no token kept it).
	 */
	private buildArgs(opener: Opener, absPath: string, line: number | null, col: number | null): string[] {
		const tokens = opener.args
			.split("\n")
			.map((t) => t.trim())
			.filter((t) => t.length > 0);

		const lineStr = line != null ? String(line) : "";
		const colStr = col != null ? String(col) : "";

		const substituted = tokens.map((t) =>
			t
				.replace(/\{path\}/g, absPath)
				.replace(/\{line\}/g, lineStr)
				.replace(/\{col\}/g, colStr)
		);

		const dropped: boolean[] = tokens.map((orig, i) => {
			const needsLineCol = /\{line\}|\{col\}/.test(orig);
			if (needsLineCol && (line == null || col == null)) return true;
			if (substituted[i].length === 0) return true;
			return false;
		});

		// Drop a flag token whose following token was dropped.
		for (let i = 0; i < tokens.length; i++) {
			if (!dropped[i] && /^-/.test(tokens[i]) && i + 1 < tokens.length && dropped[i + 1]) {
				dropped[i] = true;
			}
		}

		const result = substituted.filter((_, i) => !dropped[i]);

		// Always open *something*; append the bare path if nothing kept it.
		if (!result.some((t) => t.includes(absPath))) {
			result.push(absPath);
		}
		return result;
	}

	openWith(opener: Opener, file: TAbstractFile) {
		const absPath = this.getAbsolutePath(file);

		let line: number | null = null;
		let col: number | null = null;
		if (file instanceof TFile) {
			const leaf = this.getOpenLeafForFile(file);
			if (leaf) {
				const view = leaf.view as MarkdownView;
				const cursor = view.editor.getCursor();
				line = cursor.line + 1;
				col = cursor.ch + 1;
			}
		}

		const args = this.buildArgs(opener, absPath, line, col);
		const command = (opener.command || "code").trim();

		if (process.platform === "win32") {
			launchOnWindows(command, args);
		} else {
			spawnProcess(command, args, undefined, command);
		}
	}

	async loadSettings() {
		const data = await this.loadData();
		if (data && Array.isArray(data.openers) && data.openers.length > 0) {
			this.settings = { openers: data.openers };
		} else {
			this.settings = { openers: DEFAULT_OPENERS };
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

function launchOnWindows(command: string, args: string[]): void {
	void resolveWindowsCommand(command).then((resolved) => {
		if (/\.(cmd|bat)$/i.test(resolved)) {
			const target = parseBatchTarget(resolved);
			if (target) {
				// Unwrap the batch shim to its real executable so arguments
				// with &, spaces, etc. are passed via CreateProcess and never
				// re-parsed by cmd.exe (which splits on & inside quotes).
				spawnProcess(target.file, [...target.args, ...args], target.env, command);
			} else {
				// Couldn't unwrap — invoke through cmd with correct quoting.
				// Handles spaces; & inside a path is a documented cmd.exe
				// limitation for batch files.
				if (args.some((a) => a.includes("&"))) {
					new Notice(
						`Path contains "&" but "${command}" is a batch file, which cmd.exe cannot pass "&" arguments to. Configure the editor's .exe directly instead.`
					);
				}
				spawnViaCmd(resolved, args, command);
			}
		} else {
			spawnProcess(resolved, args, undefined, command);
		}
	});
}

/**
 * Resolve a command name to a concrete path on Windows.
 * Bare names (e.g. `code`) are looked up with `where.exe`; a path is used
 * as-is. Prefers a real `.exe` over a `.cmd`/`.bat` shim when both exist.
 */
function resolveWindowsCommand(command: string): Promise<string> {
	if (/[\\/]/.test(command) || /^[a-zA-Z]:/.test(command)) {
		return Promise.resolve(path.resolve(command));
	}
	return new Promise((resolve) => {
		execFile(
			"where.exe",
			[command],
			{ windowsHide: true, timeout: 5000 },
			(err, stdout) => {
				if (err) {
					resolve(command);
					return;
				}
				const lines = stdout
					.split(/\r?\n/)
					.map((s) => s.trim())
					.filter(Boolean);
				const exe = lines.find((l) => /\.exe$/i.test(l));
				const batch = exe ?? lines.find((l) => /\.(cmd|bat)$/i.test(l));
				resolve(batch ?? lines[0] ?? command);
			}
		);
	});
}

interface BatchTarget {
	file: string;
	args: string[];
	env: Record<string, string>;
}

/**
 * Best-effort unwrapping of a `.cmd`/`.bat` shim (e.g. VS Code's `code.cmd`)
 * into the real executable it launches plus any fixed arguments (like the
 * bundled `cli.js`) and environment variables it sets. Returns null when the
 * shim does not look like a simple launcher.
 *
 * Supported constructs: `%~dp0` paths, `set VAR=value` /
 * `set "VAR=value"`, `%VAR%` references, fixed arguments before `%*`, and
 * simple `if "A"=="B" ( ... )` conditional sets (e.g. the ARM64 branch of
 * `code.cmd`).
 */
function parseBatchTarget(batchPath: string): BatchTarget | null {
	const dir = path.dirname(batchPath);
	let content: string;
	try {
		content = fs.readFileSync(batchPath, "utf8");
	} catch {
		return null;
	}
	const lines = content.split(/\r?\n/);

	const vars: Record<string, string> = {};
	let pendingIf: { condTrue: boolean } | null = null;

	const expand = (t: string): string => {
		let s = t.replace(/%([^%]+)%/g, (_, v) => {
			const key = (v as string).trim();
			if (key in vars) return vars[key];
			return process.env[key] ?? "";
		});
		s = s.replace(/%~dp0/g, dir + "\\");
		return path.normalize(s);
	};

	for (const raw of lines) {
		const line = raw.trim();

		if (pendingIf && /^\)/.test(line)) {
			pendingIf = null;
			continue;
		}

		if (!pendingIf) {
			const cond = line.match(/^if\s+"([^"]*)"\s*==\s*"([^"]*)"\s*\(?\s*$/i);
			if (cond) {
				pendingIf = { condTrue: expand(cond[1]) === expand(cond[2]) };
				continue;
			}
		}

		const setQuoted = line.match(/^set\s+"([^"=]+)=([^"]*)"\s*$/i);
		const setPlain = line.match(/^set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/i);
		if (setQuoted || setPlain) {
			const name = (setQuoted ? setQuoted[1] : setPlain![1]).trim();
			const value = setQuoted ? setQuoted[2] : setPlain![2];
			if (!pendingIf || pendingIf.condTrue) vars[name] = value;
			continue;
		}

		if (pendingIf && !pendingIf.condTrue) continue;
		if (!line || /^(@?echo|rem|::|setlocal|endlocal|exit|if |goto|call\s+exit)/i.test(line)) continue;

		const words: string[] = [];
		for (const w of line.matchAll(/"([^"]*)"|([^\s"]+)/g)) {
			words.push(w[1] !== undefined ? w[1] : w[2]);
		}
		const exeIdx = words.findIndex((t) => /\.exe$/i.test(expand(t)));
		if (exeIdx === -1) continue;
		const file = expand(words[exeIdx]);
		if (!/\.exe$/i.test(file)) continue;
		const fixedArgs = words
			.slice(exeIdx + 1)
			.map(expand)
			.filter((t) => t && t !== "%*");
		return { file, args: fixedArgs, env: { ...vars } };
	}
	return null;
}

/**
 * Spawn a concrete executable with an argument array. No shell is involved,
 * so Node/CreateProcess do the quoting and characters like `&` and spaces in
 * paths are passed through verbatim.
 */
function spawnProcess(
	file: string,
	args: string[],
	extraEnv: Record<string, string> | undefined,
	label: string
): void {
	let child: ChildProcess;
	try {
		child = spawn(file, args, {
			stdio: "ignore",
			windowsHide: true,
			env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
		});
	} catch (err) {
		new Notice(`Failed to launch: ${(err as Error).message}`);
		return;
	}
	child.on("error", (err) => {
		new Notice(`Failed to run "${label}". Check the command in settings. (${err.message})`);
	});
}

/**
 * Invoke a command through cmd.exe with correct quoting. Every token is
 * double-quoted and the whole line is wrapped in an extra quote pair, which
 * cmd strips back off via /s — leaving each argument intact.
 */
function spawnViaCmd(command: string, args: string[], label: string): void {
	const comspec = process.env.ComSpec || "cmd.exe";
	const tokens = [command, ...args].map((t) =>
		/^".*"$/.test(t) ? t : `"${t}"`
	);
	let child: ChildProcess;
	try {
		child = spawn(comspec, ["/d", "/s", "/c", `"${tokens.join(" ")}"`], {
			windowsVerbatimArguments: true,
			stdio: "ignore",
			windowsHide: true,
		});
	} catch (err) {
		new Notice(`Failed to launch: ${(err as Error).message}`);
		return;
	}
	child.on("error", (err) => {
		new Notice(`Failed to run "${label}". Check the command in settings. (${err.message})`);
	});
}

class OpenInVSCodeSettingTab extends PluginSettingTab {
	plugin: OpenInVSCodePlugin;

	constructor(app: App, plugin: OpenInVSCodePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text:
				"Configure one or more external editors. Each adds an “Open in …” entry to the file context menu. " +
				"Placeholders: {path}, {line}, {col}. Put a flag like -g on the line above a {line}/{col} token so it is dropped automatically for folders.",
			cls: "setting-item-description",
		});

		this.plugin.settings.openers.forEach((opener, index) => {
			const block = containerEl.createDiv({ cls: "oic-opener" });
			block.style.border = "1px solid var(--background-modifier-border)";
			block.style.borderRadius = "6px";
			block.style.padding = "10px";
			block.style.marginBottom = "12px";

			new Setting(block)
				.setName("Menu label")
				.addText((t) =>
					t.setValue(opener.name).setPlaceholder("Open in VSCode").onChange(async (v) => {
						this.plugin.settings.openers[index].name = v;
						await this.plugin.saveSettings();
					})
				);

			new Setting(block)
				.setName("Command")
				.setDesc("Executable name or absolute path, e.g. code or C:\\...\\code.cmd")
				.addText((t) =>
					t.setValue(opener.command).setPlaceholder("code").onChange(async (v) => {
						this.plugin.settings.openers[index].command = v;
						await this.plugin.saveSettings();
					})
				);

			new Setting(block)
				.setName("Arguments (one per line)")
				.setDesc("Use {path}, {line}, {col}. Example for VSCode:  -g  then  {path}:{line}:{col}")
				.addTextArea((t) => {
					t.setValue(opener.args).onChange(async (v) => {
						this.plugin.settings.openers[index].args = v;
						await this.plugin.saveSettings();
					});
					t.inputEl.rows = 3;
					t.inputEl.style.width = "100%";
				});

			new Setting(block)
				.setName("Hotkey")
				.setDesc(
					"Optional shortcut to open the current file, e.g. Ctrl+Shift+O. Use Mod for Ctrl on Windows/Linux and Cmd on macOS; separate multiple shortcuts with a comma."
				)
				.addText((t) => {
					t.setValue(opener.hotkey ?? "")
						.setPlaceholder("Ctrl+Shift+O")
						.onChange(async (v) => {
							this.plugin.settings.openers[index].hotkey = v.trim();
							await this.plugin.saveSettings();
							scheduleHotkeyRefresh(this.plugin, this.plugin.settings.openers[index]);
						});
				});

			new Setting(block)
				.setName("")
				.addButton((b) =>
					b.setButtonText("Delete").setWarning().onClick(async () => {
						const removed = this.plugin.settings.openers.splice(index, 1)[0];
						await this.plugin.saveSettings();
						if (removed) {
							this.plugin.removeOpenerCommand(removed);
						}
						this.display();
					})
				);
		});

		new Setting(containerEl)
			.setName("Add opener")
			.addButton((b) =>
				b.setButtonText("+ Add").onClick(async () => {
					this.plugin.settings.openers.push({
						id: uid(),
						name: "Open in …",
						command: "code",
						args: "{path}",
						hotkey: "",
					});
					await this.plugin.saveSettings();
					this.display();
				})
			)
			.addButton((b) =>
				b.setButtonText("Restore VSCode default").onClick(async () => {
					this.plugin.settings.openers = DEFAULT_OPENERS.map((o) => ({ ...o }));
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}
}
