# Contributing to Trellis

Thanks for your interest in improving Trellis!

## Development

Requirements: Node.js 22.18+ (CI uses 24).

```bash
npm ci          # install the locked dependencies
npm run dev     # watch build for development
npm run lint    # official Obsidian + TypeScript lint checks
npm run build   # type-check + production build
npm run verify:release -- --assets # compare metadata and production assets
npm test        # run the unit test suite
npm audit --audit-level=high # use the CI security check
```

Point a test vault's `.obsidian/plugins/trellis/` folder at your build output
(or symlink it) to try changes live in Obsidian.

## Pull requests

- Keep changes focused — one topic per pull request.
- Run `npm run lint`, `npm run build`, `npm test`, and
  `npm audit --audit-level=high` before submitting; all must pass.
- Match the existing code style: TypeScript, tab indentation, and no hardcoded
  styling (use CSS classes and Obsidian's CSS variables in `styles.css`).
- Explain what changed and why in the pull request description.

## Release preparation

Obsidian's [developer policies](https://docs.obsidian.md/community-directory/developer-policies)
and [plugin requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
apply to directory releases. Keep the stable `trellis` ID, document any future
network/account/payment/outside-vault access, and preserve required third-party
license credits. Client-side telemetry and self-updating plugins are prohibited.
Trellis runs offline; its Node-based build tools are not shipped runtime code.

1. Test in a disposable vault, including upgrading saved settings, preview/apply/
   undo, interrupted changes, display toggle off/on, plugin disable/reload, and
   detached windows. Exercise the minimum supported Obsidian version and desktop/
   mobile platforms. Desktop mobile emulation does not replace device testing.
2. Choose the release version and the exact source commit together. Update
   `package.json`, its lockfile, `manifest.json`, and `versions.json` consistently.
   The release tag must be plain `x.y.z`, matching the manifest; do not blindly
   reuse a tag that points to an older implementation. This repository's version
   script stages manifest changes, so inspect it before using `npm version`.
3. From the reviewed source run `npm ci`, `npm run lint`, `npm run build`,
   `npm test`, `npm run verify:release -- <version> --assets`, and
   `npm audit --audit-level=high`. The asset check compares `main.js` byte-for-byte
   with an in-memory production build, checks required Trellis files, and rejects
   unexpected external runtime imports. It is a local safeguard, not the complete
   official server review. Both build paths use `scripts/build-options.mjs`.
4. After the source has been authorized for upload, use the directory management
   page's **Review branch** with the intended branch, tag, or commit SHA to preview
   the official scan before releasing. A scan cannot see uncommitted local work.
   The scanner chooses `build` before `build:plugin` or `compile`; keep `build` a
   production build. Review manifest, release, source, and build-verification
   findings separately; a warning is not automatically a submission blocker.
5. After authorization to release, merge the reviewed source into the default
   branch, `main`, and tag that exact commit. Check that the version in `main`'s
   `manifest.json`, the plain `x.y.z` tag, and the release asset's manifest agree.
   Obsidian checks the default branch's manifest to discover the version and
   downloads the assets from its matching release; pushing only a preparation
   branch or publishing a differently versioned release is not sufficient.
   The tag-triggered workflow builds and creates a **draft** GitHub Release with
   `main.js`, `manifest.json`, and `styles.css` as individual assets. Check the source commit, assets and `RELEASE_NOTES.md` before
   publishing. The workflow uses this reviewed file as the release body; update
   it for each release. A manual-install ZIP alone is not sufficient. Obsidian makes CSS
   optional generally, but Trellis needs its stylesheet.
6. Trellis is already registered; updates use GitHub Releases rather than a fresh
   directory submission. After publication, inspect the directory review and,
   if needed, use **Check for new releases** or **Request review**.

The manifest's `minAppVersion` is a compatibility promise. Change it when required
APIs/runtime behavior require a newer app, and maintain the fallback mapping in
`versions.json`. Using newer type definitions alone does not prove older app support.
Do not set `isDesktopOnly: false` if runtime Node/Electron dependencies are added.

Useful tools are the [official ESLint plugin](https://github.com/obsidianmd/eslint-plugin),
the [Obsidian CLI](https://obsidian.md/help/cli) (`plugin:reload`, `dev:errors`,
`dev:dom`, `dev:screenshot`, `dev:mobile` on a CLI-enabled installation), and
[mobile developer tools](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development).
BRAT can distribute opt-in beta builds; it is an optional third-party testing tool,
not a required plugin dependency or a substitute for release validation.

The directory can scan a private source repository through its GitHub App while
release assets remain public. A private backup repository is not automatically
connected; configuring that access is a separate maintainer decision. See
[entry management](https://docs.obsidian.md/community-directory/manage-entry),
[review FAQ](https://docs.obsidian.md/community-directory/faq), and the
[release instructions](https://docs.obsidian.md/plugins/releasing/submit-plugin).

## Reporting issues

Open a GitHub issue with steps to reproduce, your Obsidian version, and — if
relevant — a small example of the tags and filenames involved.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
