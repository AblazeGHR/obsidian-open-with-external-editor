import { Plugin, TFile, TFolder, TAbstractFile, Notice, Menu, MarkdownView, FileSystemAdapter, WorkspaceLeaf, PluginSettingTab, Setting, App } from "obsidian";
import { spawn } from "child_process";

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
			this.addCommand({
				id: `open-current-${opener.id}`,
				name: `Open current file in ${opener.name || "external editor"}`,
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

		this.addSettingTab(new OpenInVSCodeSettingTab(this.app, this));
	}

	onunload() {}

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
		const full = [command, ...args.map(quoteIfNeeded)].join(" ");

		try {
			const child = spawn(full, { shell: true, stdio: "ignore" });
			child.on("error", (err) => {
				new Notice(
					`Failed to run "${command}". Check the command in settings. (${err.message})`
				);
			});
		} catch (err) {
			new Notice(`Failed to launch: ${(err as Error).message}`);
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

function quoteIfNeeded(token: string): string {
	return /\s/.test(token) && !/^".*"$/.test(token) ? `"${token}"` : token;
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
				.setName("")
				.addButton((b) =>
					b.setButtonText("Delete").setWarning().onClick(async () => {
						this.plugin.settings.openers.splice(index, 1);
						await this.plugin.saveSettings();
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
