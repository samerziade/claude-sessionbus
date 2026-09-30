---
name: sessionbus
description: Use when a <channel source="sessionbus"> message arrives, when you need to reach, ask, answer, hand work to or coordinate with another Claude Code session, or when answering a person who wrote to you from a sessionbus chat room.
---

# sessionbus

## The wake rule

Only a `send_message` whose `to` names a session wakes that session. Anything you post into a
room — with or without an `@`-mention — wakes nobody, and a reply to a person reaches only that
person.

Other sessions are not reading the room. They are idle until a `<channel>` event arrives, and
the only thing that makes one arrive for them is your `send_message` to them.

## Who to address

| You want to reach            | `to`                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| another session              | its short id or name from `list_peers`, or `pm` / `epic`     |
| several sessions             | a list: `["7f3a2c1e", "frontend"]`                           |
| a person in a chat room      | their full Matrix id, the `from_id` of their message         |
| a person **and** a session   | two calls — one to each                                      |

A message to a session is mirrored into the room automatically, so the person watching still
sees it. You never need to post it twice.

## Answering a message from a room

When a message has `origin="human"`, or its transcript shows other sessions talking:

1. Reply to the person with `send_message` to their `from_id`.
2. For **every session** that must act, answer, or know — including a session whose question
   you can see in the transcript — call `send_message` with that session in `to`. Seeing a
   session's words in a room does not mean it will see yours.
3. Tell the person who you contacted.

"Mention someone by their name in the room to reach them" in the sessionbus instructions
describes how a **person** typing in a chat client reaches you. Writing a session's name or
`@name` in your own text does nothing.

## Reading, not reaching

`read_history({ room, since })` fetches what a relayed message's cap `omitted`, or another
room's discussion. It notifies nobody.

## Before you end the turn

For each session you expect to act or reply: did it get a `send_message` with it in `to`? If
not, it did not hear you — send one now.

## Common mistakes

| Mistake                                                     | Fix                                              |
| ----------------------------------------------------------- | ------------------------------------------------ |
| Replying to the person with "db-migrations, can you…"       | Also `send_message` to db-migrations             |
| Answering a session's question from the transcript in a room reply | `send_message` the answer to that session |
| Posting a status update to the person, expecting peers to see it | `send_message` the peers who need it       |
| Waiting for a peer who was never messaged                   | Message it; nothing arrives otherwise            |
