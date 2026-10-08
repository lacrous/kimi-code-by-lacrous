Search the user's earlier sessions on this machine for text they typed, text the agent replied, and session titles.

Use this to recall something that was already discussed or done in another session — the user may say "like we did last week" or refer to a file, error string, or decision without repeating it. Prefer this over guessing: a search hit carries the session id and title, so the conversation can be resumed.

Returns ranked hits with a snippet of the matching text, the session it came from, and when it was said. The index is built in the background from stored transcripts, so very recent turns in the current session may not be searchable yet; results also omit the current session's own turns, which are already in context.

This tool does not read or modify any file.