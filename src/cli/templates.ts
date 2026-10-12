/** Šablony souborů generovaných příkazem `ultracode init`. */

export const HELLO_WORKFLOW = `/// <reference path="../workflow.d.ts" />
//
// Ukázkové workflow. Spuštění:
//   ultracode run hello --args '{"name":"Ondřej"}'
//
// Skript nemá importy: agent, parallel, pipeline, phase, log, args, budget a workflow jsou globály.
// \`meta\` musí být čistý literál (žádné proměnné ani volání funkcí).

export const meta = {
  name: 'hello',
  description: 'Ukázkové workflow: jeden agent pozdraví a vrátí odpověď jako JSON.',
  whenToUse: 'Ověření, že ultracode a \`claude -p\` fungují.',
  phases: [
    { title: 'Pozdrav', detail: 'jeden agent vrátí pozdrav jako strukturovaný výstup' },
  ],
}

phase('Pozdrav')

const name = (args && args.name) || 'světe'

const odpoved = await agent(
  'Pozdrav česky osobu se jménem "' + name + '" jednou krátkou větou. Nepoužívej žádné nástroje.',
  {
    label: 'pozdrav',
    effort: 'low',
    schema: {
      type: 'object',
      properties: {
        greeting: { type: 'string', description: 'Pozdrav v jedné větě' },
      },
      required: ['greeting'],
    },
  },
)

// agent() vrací null, když selže – vždy to ošetři.
if (!odpoved) {
  log('Agent selhal, workflow nemá výsledek.')
  return { ok: false }
}

return { ok: true, greeting: odpoved.greeting }
`

export const ULTRACODE_GITIGNORE = `# Záznamy běhů (events, journal, výsledky agentů) – nepatří do gitu.
runs/
`
