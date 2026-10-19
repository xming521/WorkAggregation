# OfferPilot — Open-source AI Job Application Tracker

[简体中文](README.md) | [English](README.en.md)

OfferPilot by offercontext is a local-first workspace for individual
job seekers. Keep applications, resumes, interviews and offers together,
with optional AI assistance for preparation and review.

## Features

| Feature | Purpose |
| --- | --- |
| Application tracking | Organize companies, roles, application stages and interview schedules |
| Resume management | Maintain resume versions and review job-specific material suggestions |
| Mock interviews | Practice with your resume and job description, then review feedback |
| Interview reviews | Record lessons and select priorities for further practice |
| Offer comparison | Compare compensation, benefits and response deadlines |
| Salary negotiation preparation | Prepare questions and communication drafts |

New to AI agents? Start with [how an interview gets recorded](docs/learn/01-record-an-interview.md), or browse the [learning path](docs/learn/README.md). These tutorials are in Chinese and require no coding or installation to read.

## Getting started

A [Windows x64 unsigned test build (v0.1.0-desktop.1)](https://github.com/offercontext/offerPilot/releases/tag/v0.1.0-desktop.1) is available. You can also run OfferPilot locally with Docker or from source.

### Windows x64 desktop test build (unsigned)

This is an experimental prerelease, not a stable production release. Python, Node.js and Docker are not required for the installer.

1. Under the Release's Assets, download `OfferPilot-Desktop-0.1.0-desktop.1-win-x64-setup.exe` and its matching `.sha256` file. The automatically generated Source code archives are not installers.
2. Before installing, run `Get-FileHash .\OfferPilot-Desktop-0.1.0-desktop.1-win-x64-setup.exe -Algorithm SHA256` in PowerShell and compare it with the checksum file and Release notes. A hash checks integrity; it does not authenticate the publisher.
3. After verifying the source and hash, open the installer, choose an installation folder, then launch the desktop shortcut. This unsigned build may trigger Windows SmartScreen or an unknown-publisher warning. If your browser, Windows or security software blocks the download or execution, stop and report it; do not disable protection or bypass warnings.
4. Start with test data. Before installing another version, fully quit the app and back up `%APPDATA%\OfferPilot Desktop\`. This workspace is separate from the source edition's `~/.offerpilot`; migration is not automatic and upgrade/downgrade compatibility is not guaranteed. Uninstalling retains app data by default, which is not a substitute for a backup.

The release update channel is not enabled; in-app update checks, downloads and installation are unavailable. Get future test builds manually from Releases. Real QQ mailbox setup and resumed mailbox reading are disabled in this EXE; manual email pasting and suggestion review remain available. AI features require your own model service and may transmit relevant data and incur provider fees.

See the Release notes for build provenance, checksums and validation scope, plus the [desktop validation notes](docs/architecture/desktop-validation.md) and [update boundaries](docs/architecture/desktop-updates.md) (Chinese).

### Docker or source

See the [installation instructions](README.md#快速开始)
and [user guide in Chinese](docs/product-manual/产品说明书.md).

Basic application tracking does not require AI configuration.

## Privacy and limitations

Workspace data is stored locally. AI features send relevant materials
to your configured model service and may incur provider fees.

OfferPilot does not automatically submit applications or message recruiters.
Review generated content before using it.

## License

See [LICENSE](LICENSE) and the
[third-party notices](README.md#许可证).
