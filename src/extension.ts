import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel;

function registerStubCommand(
  context: vscode.ExtensionContext,
  command: string,
  title: string
): void {
  const disposable = vscode.commands.registerCommand(command, () => {
    vscode.window.showInformationMessage(
      `Alembic Graph: ${title} — not implemented yet`
    );
  });
  context.subscriptions.push(disposable);
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Alembic Graph");
  context.subscriptions.push(outputChannel);

  registerStubCommand(context, "alembicGraph.openGraph", "Open Migration Graph");
  registerStubCommand(context, "alembicGraph.refresh", "Refresh");
  registerStubCommand(context, "alembicGraph.upgradeHead", "Upgrade to Head");
  registerStubCommand(context, "alembicGraph.mergeHeads", "Merge Heads…");
  registerStubCommand(context, "alembicGraph.selectProject", "Select Alembic Project…");

  outputChannel.appendLine("activated");
}

export function deactivate(): void {}
