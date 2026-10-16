# codex-image-gen++

[中文](README.zh-CN.md) · English

A small, local MCP server that connects Codex to your own OpenAI-compatible Image API. Configure the provider once; let Codex choose the model, prompt, parameters and workspace output filename for each task.

**Windows · macOS · Linux | 中文 / English setup | MIT**

## Install

Requires **Node.js 22.13 or newer** (Node.js 24 LTS recommended), npm, and the [Codex CLI](https://developers.openai.com/codex/cli). The desktop app can use the registered stdio MCP too. Install the CLI if you want automatic registration.

Install the built package from [GitHub Releases](https://github.com/Anti2077/codex-image-gen-plus-plus/releases):

```sh
npm install -g https://github.com/Anti2077/codex-image-gen-plus-plus/releases/latest/download/codex-image-gen-plus-plus.tgz
codex-image-gen-plus-plus init
```

The npm package registry is not required. The display name is `codex-image-gen++`; the repository, executable and MCP entry use `codex-image-gen-plus-plus` for naming compatibility.

Or build from source (Git required):

```sh
git clone https://github.com/Anti2077/codex-image-gen-plus-plus.git
cd codex-image-gen-plus-plus
npm ci
npm run build
npm link
codex-image-gen-plus-plus init
```

Keep the source directory if installing with `npm link`. Registration uses absolute Node and CLI paths; rerun `init` if you move the installation or replace Node.

## Setup

1. Choose **中文 / English**.
2. Enter the provider API base URL and a hidden API key. A root URL such as `https://api.example.com` becomes `https://api.example.com/v1`; a custom path such as `/gateway/v1` is preserved.
3. Fetch `/models` to check connection and authentication. This step **does not generate an image or incur image-generation charges**. The provider may charge for API requests under its own policy.
4. Choose whether to register with Codex. Setup invokes the official `codex mcp add` command and updates the entry with this name. If Codex cannot be found, it prints a manual TOML entry.
5. Copy the supplied paragraph into your **Codex personalization instructions** to prefer this MCP for images. Setup does not edit those instructions automatically.

Restart Codex or open a new chat after registration. No model or output directory is fixed in configuration.

Example request to Codex:

> Use codex-image-gen++ to list the available image models, choose one, and create a square watercolor fox illustration. Save it in this workspace's output/imagegen/ directory and show the result.

Codex should call `list_models` and pass the exact model ID. Provider-visible model IDs and name hints do not establish generation permission, pricing, quality or speed. Names such as `flare` and `sunburst` are passed through without assumed rankings or aliases.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_models` | Fetch visible model IDs, with an optional substring filter and image-name hints. |
| `generate_image` | Submit a generation request and save the result to an absolute local filename. |
| `edit_image` | Submit local reference images and an optional mask as multipart data. |
| `get_job` | Retrieve an existing job; optionally wait up to 20 seconds. Never submits another request. |

Generation/edit arguments: `model`, `prompt`, `output_path`; optional `size`, `quality`, `background`, `n` (1–4). Edits also take `input_paths` (1–16) and optional `mask_path`. Provider limits may be lower.

Output extension `.png`, `.jpg` / `.jpeg`, or `.webp` sets `output_format`. Existing files are never overwritten. With `n: 2` and `output_path: /absolute/workspace/output/imagegen/fox.png`, files are `fox-1.png` and `fox-2.png`. Output reports measured dimensions, bytes, SHA-256, and whether a requested explicit size matches. Dimensions come from image headers, not a complete image-decoding check; Codex should inspect the saved image.

Use **absolute paths inside the current workspace**. The MCP process's working directory may differ from the chat's workspace. Codex chooses the destination and the server writes the bytes directly, returning paths and metadata instead of large Base64 blobs. This local MCP has the filesystem permissions of the account running it; absolute paths are required, but workspace containment is an agent instruction, not an enforced filesystem sandbox.

## Long requests and failures

Images run in a detached local Node worker. The initial tool call waits up to 15 seconds, then returns a job ID if still pending, keeping ordinary MCP calls below the default timeout. Use `get_job` rather than submitting again. Jobs continue through an MCP disconnect while the worker and computer remain running.

No automatic request retries, model fallback, or protocol guessing. A network timeout may occur after the provider accepted a paid request; inspect the job, output files and provider logs before deciding to submit again. Failed jobs include a code, `outcome_unknown`, provider request ID when available, and any successfully saved partial files. A worker interrupted by shutdown/crash is reported as interrupted; it is not resumed automatically. A hard worker crash can leave empty reserved files that need manual inspection/removal.

## Provider compatibility

The initial implementation supports the **OpenAI-compatible Images API**:

- `GET {baseUrl}/models`
- `POST {baseUrl}/images/generations` with JSON
- `POST {baseUrl}/images/edits` with multipart (`image` for one input, `image[]` for multiple inputs)
- `data[].b64_json`, `data[].url`, or `data[].image_url` string responses

It is not a universal adapter for every image provider. APIs requiring Responses-only tools, custom job/polling endpoints, OAuth, or proprietary request bodies need a future adapter. Providers must support `output_format` or return an image format that matches the requested extension. Optional size/quality fields are sent only when supplied; quality values are not limited to an old fixed model list.

API URLs require HTTPS, with HTTP allowed for loopback development. API authentication never follows redirects. Returned image URLs may contain signed queries and follow up to five redirects, without forwarding your provider API key. Response limits are 50 MiB per image and 192 MiB per generation JSON response.

## Configuration and privacy

| System | Default config file |
| --- | --- |
| Windows | `%APPDATA%\codex-image-gen-plus-plus\config.json` |
| macOS | `~/Library/Application Support/codex-image-gen-plus-plus/config.json` |
| Linux | `$XDG_CONFIG_HOME/codex-image-gen-plus-plus/config.json`, or `~/.config/...` |

The API key is stored as **plaintext in the local config file**, not in the project or Codex TOML. POSIX directories/files are created with modes 700/600; Windows uses inherited user-directory ACLs. There is no keychain integration. Keep the file private.

Optional environment overrides: `CODEX_IMAGE_GEN_CONFIG` (absolute config path recommended), `CODEX_IMAGE_GEN_BASE_URL`, `CODEX_IMAGE_GEN_API_KEY`. Do not put keys in terminal command arguments, source control, or chat. The default provider timeout is 600 seconds; `timeoutSeconds` in config accepts 1–3600.

Jobs are stored beside config under `jobs/`, containing prompts, input/output paths, status and metadata, **without copying the API key**. They persist until you delete them; remove completed job JSON files when no longer needed. Images and prompts are sent to your configured provider; signed result URLs are fetched locally. This project has no analytics endpoint.

## Commands

```sh
codex-image-gen-plus-plus init
codex-image-gen-plus-plus models image
codex-image-gen-plus-plus doctor
codex-image-gen-plus-plus instructions zh-CN
codex-image-gen-plus-plus instructions en
codex-image-gen-plus-plus job <job-id>
```

`doctor` checks `/models`, not a paid generation. Rerun `init` to change the provider or key. On PowerShell, if script execution policy prevents npm command shims, use `codex-image-gen-plus-plus.cmd init` instead.

To disconnect, run `codex mcp remove codex-image-gen-plus-plus`. Remove the config/jobs directory separately if you want to delete the stored key and history. Uninstall a global package with `npm uninstall -g codex-image-gen-plus-plus`.

## Development

```sh
npm ci
npm run check
npm run build
npm pack
```

CI builds and checks the CLI/package on Windows, macOS and Linux with Node.js 22 and 24. This does not establish compatibility with every third-party provider. Real generation consumes your provider credits and is not part of setup or CI.

## Acknowledgements

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for related open-source projects and the official MCP SDK. Original implementation; MIT licensed.
