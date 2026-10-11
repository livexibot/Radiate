# Helping with Radiate

Thank you for wanting to help. Radiate is a small project with one owner,
so every issue and pull request is read, and nothing is merged until the
owner has approved it.

## Something is wrong

[Open an issue](https://github.com/livexibot/Radiate/issues/new/choose)
with the "Something is wrong" form. Say what happened, how to make it
happen, your Radiate version (Settings, About) and your system. Please
never paste a playlist link, a server address, a username or a password:
they are your provider account.

Security problems go [privately](https://github.com/livexibot/Radiate/security/advisories/new),
not in an issue (see [SECURITY.md](SECURITY.md)).

## An idea

Open an issue with the "An idea" form. Pictures or examples from other
players help.

## Code

1. For anything larger than a small fix, open an issue first, so we can
   agree on it before you spend time on it.
2. Fork the repository, make a branch, and open a pull request into `main`
   with a title like `feat: ...` or `fix: ...`. Fill in the template:
   what was there before, what is there after, and how.
3. CI checks formatting, runs the tests and builds the app for Windows,
   macOS and Linux.
4. The pull request is reviewed, and merged once the owner approves it.

What you contribute is under Radiate's [MIT licence](LICENSE), like the
rest of the code.

### What Radiate will not take

- Channels, playlists, provider links or anything that points people to
  where to get them. Radiate plays sources the user already has.
- Anything that gets around a provider's connection limit, geo-blocking,
  copy protection or terms (account rotation, connection sharing, spoofing).
- Telemetry, ads or accounts. Radiate talks only to the user's own sources
  and guides, and to the free public catalog when the user picks it.

### Building

You need Rust (stable), Node.js 22, and on Linux Tauri's system packages
(`libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev patchelf`).

```
cd apps/desktop
npm install
npm run tauri dev        # the app, with hot reload
npm run dev              # the interface alone in a browser, with made-up channels
cd ../..
cargo test               # the core and the stream relay
```

Run `cargo fmt` and `npm run lint` before you push.

## Be kind

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
