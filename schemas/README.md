# Make's editor schemas

The JSON schemas Make's VS Code extension uses to check app files, copied unchanged from
[integromat/vscode-apps-sdk](https://github.com/integromat/vscode-apps-sdk) at commit
`6ff5f3dd9960ccbeb24de3beb1cca935de89eaa0` (`syntaxes/imljson/*.json` and
`src/local-development/makecomapp.schema.json`). License: `LICENSE.md` (Celonis, MIT terms).

`test/structure.test.mjs` validates every app file against them. The schemas are draft-07 and need
Ajv with `{ allErrors: true, strict: false, unicodeRegExp: false }`; each one is added under its file
name, because they refer to each other by file name (`"$ref": "parameters.json"`).

To update: copy the same files from a newer commit of the extension, change the commit above, and
run `npm test`.
