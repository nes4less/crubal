Each write hashes on its own (SHA-256 of its canonical form), and an entry's hash is SHA-256 of its canonical
form without `sig` with each write replaced by `sha256:` and the write's hash (chapter 8.5). A Store-level
implementation checks the links here; signed cases (011, 012) check signatures too.
