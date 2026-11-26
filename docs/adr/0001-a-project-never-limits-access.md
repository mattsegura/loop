# A Project never limits Access

The first Projects were isolated spaces: one tag on an Item said where it is and who can reach it, so an Agent that opened a Project lost the rest of the Workspace. On 2026-11-23 the owner defined a Project as a drawer. A Project now only orders and places Items, and each Limit belongs to an Agent, a person or an address as its own rule. An Agent that a Project limits today keeps that Limit until the owner removes it.

## Considered Options

- **Isolated Projects, as before.** Rejected: to open a drawer must not take other drawers away.
- **Two kinds of Project, open and sealed.** Rejected: the owner then has to know for each Project if it protects something, and what an Agent can reach depends on the drawer that is open.

## Consequences

- Code that decides Access must not read the Open Project. The Open Project may only sort results and say where a new Item goes.
- An Item that is put in a Project still reaches each caller whose Limit or Share names that Project. For a Share it waits for the yes of the owner (an Offer). This part is not built yet.
