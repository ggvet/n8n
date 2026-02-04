# TODO (MVP)

## workflow-sdk

## agent
- [ ] clarify append merge mode. 1 item for each branch, returns 2 items.
	- for combine, return 1 item
- [ ] generate mock data for output data based on schema
- [ ] for webhoook path should not use placeholder
- [ ] remove agent check in req

## ready to release
- [ ] Refactor & Review PR
- [ ] Get it reviewed

- [ ] rerun evals comparing - Fri
- [ ] legal concerns around templates

- [ ] credit tracking
- [ ] Remove logging from agent. also remove the generated log files.
- [ ] Add sentry tracking if workflow code generation step fails in prod.
- [ ] caching the requests. make sure system prompt
- [ ] caching the type requests? talk to oleg
- [ ] Update telemetry and prompt viewer app to support the code and workflow generated

## manual testing
- [ ] credit tracking
- [ ] revert to previous version etc?
- [ ] success/error states, expression, execution data resolving etc.
- [ ] handling of large workflows
- [ ] context limits with many types of nodes
- [ ] long conversations and compaction
- [ ] stickies
- [ ] fromAi
- [ ] execute and refine
- [ ] unknown nodes
- [ ] community nodes
- [ ] test multi agent setup
- [ ] how it handles validation issues in existing workflows?

## Nice to haves / tech debt
- [ ] fix up sticky sizing and positioning to cover nodes
- [ ] improve position of branches (i.e. split in batches, error branches)
- [ ] toolsWithoutParameters in sdk
- [ ] clearer error with output data mismatch
- [ ] support 1_3 as version numbers in generating types
- [ ] Parameters?: should not be optional in types if some key in there is not optional
- [ ] clean up print prompt
- [ ] why is agent node accepting arrays as models? fallback model? how to clarify this better?
- [ ] test out prompt with/without sdk reference
- [ ] fromAI expressions replace in json -> code
- [ ] rename get nodes tool to get_node_types
- [ ] export and use rlc()
- [ ] move node-specific builder validations to node level rather than at sdk level
- [ ] Test more of the template library
- [ ] update workflow() to support object init { id, settings }
- [ ] move generated test files for committed workflows to same folder.
- [] Fallback model in agent? how to represent that effectively. builderHint to true.
- [] Make the nodes search more fuzzy
{
  toolCallId: 'toolu_01RGtGMG78Wb6jX9HDpqHpvq',
  args: { queries: [ 'vector store insert', 'vector store load' ] }
}
- [] Support switch case fallback connection (.onFallback)
- [ ] Add more error branch workflows tests [maybe-later]
- [ ] merge() abstraction? or split out merge into separate functions? so its easier to understand [maybe-later]- [ ] create custom node parameter discriminators by output type (simplify in gmail node) [maybe-later] for now use builder hint
- [ ] Support switch case fallback connection (.onFallback) [maybe-later]
- [ ] Add more programmatic validations: [based-on-evals]
		- [ ] chat memory issue
		- [ ] expression without '='
		- [ ] invalid expression syntax
		- [ ] .json.key references are correct based on output data
		- [ ] .json is used when referencing data in expressions or code node
		- [ ] invalid .item or .all keys in code nodes based on mode
		- [ ] optional warning for code node?
- [ ] test out disabling agent static prompt warning
	- [ ] improve understanding of expressions. often hitting MISSING_EXPRESSION_PREFIX.

## Future improvement
- [ ] integrate with planning agent?
- [ ] improve generating static pin data
	- [ ] have agent generate pin data for http request / webhook nodes
	- [ ] should only generate pin data for nodes that also don't have pin data, never replace
- [ ] planning agent
- [ ] Add system message validation for Toolagent and no tools validation
- [ ] New validation: For tool, should use $fromAI in multi orchestrator workflow
- [ ] New validation: Respond to webhook only if web hook node is attached and configured correctly
- [ ] when generating json -> code, add "nodes" to sticky() so that llm understands connection to nodes
- [ ] named branches support (switch /text classifier / if). onCase('case') instead of onCase(0)
- [ ] use random generator for pin data
- [ ] RLC Support
- [ ] generate pin data using a random generator, rather than ai.
- [ ] Support templates as examples
- [ ] Add support for expr() functions that narrow down types for context. Basically llm should generate code rather than strings.
- [ ] support runOnceForAllItems and other code node functions. move to code node type file.
- [ ] AI still generates position unnecessarily. we should remove this and generate these seperately.
	- [ ] Positions should be calculated programmatically. When making edits, we should programmaticaly calculate where all the nodes should go.
- [ ] Add text editing tools support, to improve iteration
- [ ] fine tuning model with sdk code
- [ ] abstract away rlc() -> { _rlc: true, mode, value} resource locator component
- [ ] Evaluate with thinking enabled for each model. uses <planning> now


Feature Support Summary
 ┌──────────────────────────────┬─────────────────┬──────────────────┐
 │           Feature            │ Old Multi-Agent │ New Code Builder │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ RLC Pre-fetching             │ ✅              │ ❌  (NOT MVP)     │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ RLC Tool                     │ ✅              │ ❌  (NOT MVP)     │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Integration with planning    │ ✅              │ ❌  (If time allows)     │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Template Search              │ ✅              │ ❌   (NOT MVP, should go into planning)     │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Template Search              │ ✅              │ ❌   (NOT MVP, should go into planning)     │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Template Caching             │ ✅              │ ❌   (NOT MVP, should go into planning)    │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Credit tracking              │ ✅              │ WIP              │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Execution Data               │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Execution Schema             │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Expression Values            │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Resource/Operation Discovery │ ✅              │ ✅                │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Best Practices Tool          │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Error Recovery Mode*         │ ✅              │ ✅              │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Messag History, Compaction   │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Node Search                  │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Node Details                 │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Current Workflow Context     │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ Validation                   │ ✅              │ ✅               │
 ├──────────────────────────────┼─────────────────┼──────────────────┤
 │ TypeScript SDK Output        │ ❌              │ ✅               │
 └──────────────────────────────┴─────────────────┴──────────────────┘

Error Recovery & Builder Recovery Mode ❌

 What it is: Sophisticated error handling when subgraphs fail.

 Old Architecture:
 - Coordination log tracks failures with metadata
 - Builder recursion errors captured with partialBuilderData
 - Configurator has buildRecoveryModeContext() for recovering from partial builds
 - Multi-phase retry logic

 New Code Builder:
 - Simple consecutive error tracking (3 parse errors = fail)
 - Validation warnings get one correction attempt
 - No partial workflow recovery
 - generationErrors tracked but only for reporting

 Impact: Less robust recovery from complex failures; agent may fail entirely instead of salvaging partial work.
