const { Project, SyntaxKind, Node } = require('ts-morph');

async function clean() {
    const project = new Project({
        tsConfigFilePath: "tsconfig.json",
    });
    const sourceFile = project.getSourceFileOrThrow("src/ai/flows/infralith/blueprint-to-3d-agent.ts");

    let removedCount = 0;

    function removeUnused() {
        let changed = false;
        for (const statement of sourceFile.getStatements()) {
            if (Node.isExportable(statement) && statement.isExported()) {
                continue;
            }

            let isUnused = false;
            let nameNode = null;

            if (Node.isClassDeclaration(statement) || Node.isFunctionDeclaration(statement) || Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement)) {
                nameNode = statement.getNameNode && statement.getNameNode();
            } else if (Node.isVariableStatement(statement)) {
                const decls = statement.getDeclarationList().getDeclarations();
                if (decls.length === 1) {
                    nameNode = decls[0].getNameNode();
                }
            }

            if (nameNode) {
                let refs = [];
                try {
                    refs = nameNode.findReferencesAsNodes();
                } catch (e) {
                    // ignore
                }
                const otherUses = refs.filter(n => n.getText() === nameNode.getText() && n.getStart() !== nameNode.getStart());
                if (otherUses.length === 0) {
                    console.log(`Removing ${statement.getKindName()} : ${nameNode.getText()}`);
                    statement.remove();
                    changed = true;
                    removedCount++;
                    break; // Start over since AST is modified
                }
            }
        }
        return changed;
    }

    while (removeUnused()) { }

    console.log(`Total removed: ${removedCount}`);
    await sourceFile.save();
}

clean().catch(console.error);
