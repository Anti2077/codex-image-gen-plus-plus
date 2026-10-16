# Third-party notices and acknowledgements

This is an independent implementation, not a fork. Related open-source projects reviewed for workflow ideas:

- [pang-cream/codex-image-router](https://github.com/pang-cream/codex-image-router) — MIT; terminal setup and image-file workflows.
- [smrcdr/smartapi-images](https://github.com/smrcdr/smartapi-images) — MIT; explicit failure handling and image output checks.
- [shinpr/mcp-image](https://github.com/shinpr/mcp-image) — MIT; image-provider integration examples.
- [ShalomObongo/codex-imagegen-mcp](https://github.com/ShalomObongo/codex-imagegen-mcp) — Apache-2.0; Codex MCP installation workflow.

No source files from those projects are bundled. They do not endorse or maintain this project.

The importer interoperates with [CC Switch](https://github.com/farion1231/cc-switch) by reading its local provider selection and SQLite data schema. No CC Switch source is bundled.

Runtime dependencies include the official [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), Inquirer, Zod, image-size, and smol-toml. Their respective license texts are distributed with their npm packages. The project license does not replace dependency licenses.
