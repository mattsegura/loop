# Loop

Loop is one hub for the accounts, knowledge and secrets that a person's agents use. This glossary names the things that Loop holds, how they are kept in order, and who can use them.

## Language

### Order

**Item**:
One thing that Loop holds and an Agent can find: a Connection, a Skill, a Memory, a Task, a Vault key or an Artifact.
_Avoid_: Resource, asset, entity

**Library**:
The page that holds what Loop knows and shows how it is connected. It has four parts: Memories, Saved, Files and Schedules. A Memory stays one fact, and it is one kind of thing in the Library.
_Avoid_: Brain, Wiki, Memory (as the name of the page), Saved tab

**Project**:
A named drawer that keeps related Items together. It puts its Items first, and it never gives, hides or removes Access.
_Avoid_: Profile, space, collection, folder, Home group, Category

**Place**:
The fact that an Item is in a Project, with the one who put it there. An Item can have several Places.
_Avoid_: Tag, membership

**Main Project**:
The one Project of an Item where Home counts it.
_Avoid_: Parent, owner Project

**Open Project**:
The Project that a session of an Agent works in now. New Items go there.
_Avoid_: Scope, active profile

**Artifact**:
The record of a thing that an Agent made: its title, type, address, maker and time. The thing itself stays where it is.
_Avoid_: File, output, attachment

**Link**:
What joins two Items of the Library, with one word for how they relate: relates, cites, made from, part of, extends, updates or contradicts. A person or an Agent makes it. Items that only share a tag or words are near each other, not linked.
_Avoid_: Edge, reference, backlink, relation

**Source**:
A saved web page or a File as it came into the Library, before anyone wrote from it.
_Avoid_: Raw document, input, Link (for a saved web page)

**Note**:
A page in Saved that a person or an Agent wrote. It can have a Link to each Source and Memory that it was made from.
_Avoid_: Wiki page, article, summary

**Gather**:
To put chosen Items of the Library on one page and keep that page as a Note.
_Avoid_: Compile, synthesize, export

### Feedback

**Feedback**:
What an Agent reports to the Operator about Loop itself, if the Owner allows it. It is untrusted text, and no Agent gets it back.
_Avoid_: Review, ticket, complaint

**Issue**:
One cause that triage found in Feedback, in its own words. A person accepts it before anyone works on it.
_Avoid_: Bug, request, report

### Access

**Workspace**:
All Items, Projects and Access of one Owner.
_Avoid_: Account, tenant

**Agent**:
A program that works for a person through Loop and has its own Access.
_Avoid_: Client, bot, app

**Access**:
What an Agent or a person may see, use and change. It belongs to that Agent or person.
_Avoid_: Scope, isolation

**Limit**:
A rule that makes the Access of one Agent, person or address smaller. It can name a Project, and then it means the Items that are in that Project.
_Avoid_: Project isolation, fixed profile

**Operator**:
The person or team that runs a Loop server. On your own computer it is the Owner.
_Avoid_: Admin, host

**Owner**:
The person whose Workspace it is, and the only one who can make Access larger.
_Avoid_: Admin, user

**Guest**:
A person whom the Owner lets use a part of the Workspace.
_Avoid_: Member, collaborator

**Share**:
A rule of the Owner that lets a Guest use the Items of a Project that the Owner said yes to.
_Avoid_: Invite, publication

**Offer**:
An Item that an Agent or Loop put in a shared Project and that waits for the yes of the Owner.
_Avoid_: Request, pending share
