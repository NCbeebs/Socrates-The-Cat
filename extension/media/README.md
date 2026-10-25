# Marketplace media (Phase 6)

PNG assets for the Visual Studio Marketplace listing. **Not all are committed yet** - capture on a clean desktop VS Code window before first public publish.

| File | Min size | Content |
|------|----------|---------|
| `icon.png` | 128×128 | Socrates face or full cat; transparent background preferred |
| `screenshot-start.png` | 1024×768+ | Command Palette showing **Socrates: Start** (crop IDE chrome OK) |
| `screenshot-cat.png` | 1024×768+ | Cat on an IDE ledge (status bar or tab strip) |
| `screenshot-diagnostics.png` | 1024×768+ | **Socrates** output channel after **Show Diagnostics** |

After adding files, set in `extension/package.json`:

```json
"icon": "media/icon.png"
```

Re-run `npm run package:win` and verify with `npx @vscode/vsce ls --tree` from `extension/`.
