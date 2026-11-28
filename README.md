# ps5-tools-feed
Public release catalog for PS5 Account Tools and FC27 Squad Updater.

[payloads.json](https://raw.githubusercontent.com/amirhossein-khadem/ps5-tools-feed/main/payloads.json) is the Custom Repository URL. Add it under **Repository → Manage sources** in PS5 Payload Manager. The catalog uses the documented object format with a repository name and a list of payloads. [Custom Repository specification](https://github.com/itsPLK/ps5-payload-manager/blob/main/CUSTOM_REPOSITORIES.md)

## Add a payload

1. Identify the publisher's official GitHub repository and confirm which `.elf` asset belongs to the payload. Use the exact spelling shown on the publisher's Releases page.
2. Add an object to [publishers.json](publishers.json) with the fields below. Use a new ID and keep it for every version of the same payload. The existing entries show the complete configuration for a stable publisher.
3. Run `node --test` and then `node scripts/refresh.mjs --check` with Node.js. The second command queries the publisher and reports each verification result without writing the catalog. Confirm that the new ID reports `Verified` before committing.
4. Commit and push the change to the default branch. The workflow tests the configuration and publishes the verified entry into `payloads.json`. Check the workflow log before using the catalog. Scheduled checks run every 30 minutes, at minutes 17 and 47 of each hour (UTC).

| Field | Value |
| --- | --- |
| `id` | Stable, unique identifier using lowercase letters, digits, dots, underscores or hyphens. |
| `name` | Display name in Payload Manager. |
| `repository` | Official GitHub repository in `owner/repo` form. |
| `assetNames` | One or more exact ELF filename templates. `{tag}` is the literal tag and `{version}` drops its leading `v` or `V`. One uploaded asset must match. |
| `releasePolicy` | `stable` checks the publisher's latest stable GitHub release. `prerelease` searches published releases marked as pre-releases and selects the highest matching version. |
| `versionScheme` | `numeric` accepts two to four dot-separated numbers and an optional `v`. For `prerelease`, choose `numbered-prerelease`, which supports an optional qualifier before `alpha`, `beta`, `rc` or `test` and an optional stage number. |
| `category`, `author`, `description` | Optional display metadata. |

Version components and stage numbers compare numerically. For the same base version and qualifier, stage names follow Payload Manager's alphabetical order and the stable version sorts after the pre-release. Releases with an older version or conflicting SHA-256 for the same version leave the verified entry in place. The feed uses the official asset's GitHub SHA-256, and Payload Manager verifies that checksum when it downloads the ELF.

## Record a manually verified release

1. Confirm that the original announcement came from the publisher, including when it was posted to Discord or an external site. Obtain SHA-256 from the publisher through an authenticated source, or verify the publisher's signature on the file and then compute its SHA-256.
2. Add a `manualRelease` object to the matching publisher in `publishers.json`. Record the actual `version`, exact ELF `filename`, direct HTTPS download `url`, 64-digit hexadecimal `checksum`, release date `last_update` in `YYYY-MM-DD` format and HTTPS announcement `source`. Use a persistent download URL so Payload Manager can retrieve the same file.
3. Run `node --test` and `node scripts/refresh.mjs --check` before committing. The release check verifies the approved download's ELF header and SHA-256 before accepting a new manual version. Keep the announcement available for review. The maintainer authenticates the source, and the script verifies the downloaded bytes against the recorded digest.

The workflow checks configured publishers and submitted manual approvals. It retains each last verified catalog entry when a check fails. It publishes metadata for manual use in Payload Manager.
