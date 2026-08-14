# Contributing to Trellis

Thanks for your interest in improving Trellis!

## Development

Requirements: Node.js 22.18+ (CI uses 24).

```bash
npm ci          # install the locked dependencies
npm run dev     # watch build for development
npm run lint    # official Obsidian + TypeScript lint checks
npm run build   # type-check + production build
npm test        # run the unit test suite
```

Point a test vault's `.obsidian/plugins/trellis/` folder at your build output
(or symlink it) to try changes live in Obsidian.

## Pull requests

- Keep changes focused — one topic per pull request.
- Run `npm run lint`, `npm run build`, and `npm test` before submitting; all
  three must pass.
- Match the existing code style: TypeScript, tab indentation, and no hardcoded
  styling (use CSS classes and Obsidian's CSS variables in `styles.css`).
- Explain what changed and why in the pull request description.

## Reporting issues

Open a GitHub issue with steps to reproduce, your Obsidian version, and — if
relevant — a small example of the tags and filenames involved.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
