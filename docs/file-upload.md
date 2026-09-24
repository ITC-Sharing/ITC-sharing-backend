# File upload flow

How a file gets from the upload form to a document other students can open.

Two things make this more than a single `POST`: files are **staged before the
form is submitted**, so the transfer overlaps with the user typing; and an
upload is **not visible until a moderator approves it**, so "uploaded" and
"published" are different moments.

---

## The short version

```
pick a file ──▶ POST /documents/staged-files ──▶ MinIO + staged_files row
                     (one call per file, while the form is still open)

submit form ──▶ POST /documents (staged_file_ids + metadata)
                     └─▶ uploads row (status: pending)
                     └─▶ documents row per file
                     └─▶ notify reviewers (fire-and-forget)

moderator   ──▶ PATCH /admin/documents/group/:id/approve
                     └─▶ uploads.status = 'active'  ──▶ now in the feed
```

---

## 1. Staging — one call per file

`POST /documents/staged-files` · guard `JwtAuthGuard` · rate tier `upload`

The form calls this the moment a file is picked, so a 15 MB PDF is already on
its way while the student is still choosing a subject. It returns a handle the
form holds until submit.

What happens per call, in order:

| Step                     | Detail                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Multer intercepts     | `memoryStorage()`, `limits.fileSize` 20 MB, `fileFilter` against the MIME allowlist. Rejected before the handler runs.                                                                                                                                                                                                                                                                                                  |
| 2. Stale sweep           | `purgeStaleStaged(uploaderId)` deletes this user's staged rows older than **24 h**, objects included. No scheduler — the cost rides along with the next upload, and it only touches the caller's own rows.                                                                                                                                                                                                              |
| 3. Decode the name       | `decodeUploadName()` — multipart filenames arrive latin1-decoded, so `តេស្ត.png` would otherwise be stored mangled. Guarded: bytes that are not valid UTF-8 are handed back untouched rather than corrupted twice.                                                                                                                                                                                                      |
| 4. Reserve quota         | The per-user byte budget is charged the bytes **received**, before anything expensive runs. Charging the stored size instead would leave the abuse this bounds — pushing volume at the server — wide open, since Sharp can shrink a 20 MB photo to 200 KB. A file rejected at step 5 stays charged, deliberately: otherwise invalid bytes would be free to send without limit. Refunded only if the write itself fails. |
| 5. Validate the bytes    | `validateFileContent()` reads the magic bytes and confirms they match the extension. A `.jpg` carrying HTML is refused here, before anything is written.                                                                                                                                                                                                                                                                |
| 6. Scan for malware      | The original buffer is streamed to `clamd` (INSTREAM). Infected → `400`, with the signature name in the log and not in the response. Scanner unreachable → `503`: an unscanned upload is refused, never stored.                                                                                                                                                                                                         |
| 7. Optimise, if an image | JPEG/PNG go through Sharp: capped at 1920px on the longest edge, never upscaled, metadata stripped by the re-encode. Everything else is stored byte-for-byte.                                                                                                                                                                                                                                                           |
| 8. Put the object        | Key is `staged/<uploaderId>/<uuid>.<ext>` in the private `documents` bucket — a v4 UUID, carrying nothing of the original filename.                                                                                                                                                                                                                                                                                     |
| 9. Build a preview       | Office files only (`ppt pptx doc docx …`) — LibreOffice renders a PDF beside the original, 60 s timeout. **Best effort**: on failure `preview_url` stays null and the upload still succeeds.                                                                                                                                                                                                                            |
| 10. Record the handle    | A `staged_files` row: `file_url`, `storage_key`, `preview_url`, `preview_key`, `original_name`, `file_size_kb`.                                                                                                                                                                                                                                                                                                         |

If the row fails to save, the objects just written are removed again — a staged
file never exists in storage without a row pointing at it.

**Removing a file from the form** calls `DELETE /documents/staged-files/:id`,
which checks ownership before deleting the row and its objects.

### Allowed types

PDF · DOC/DOCX · PPT/PPTX · JPEG · PNG · ZIP · RAR.

Checked **twice**, and the second check is the one that counts:

1. Multer's `fileFilter` rejects on `file.mimetype` — cheap, and it stops the
   obvious cases before the body is buffered.
2. `validateFileContent()` reads the magic bytes and requires them to agree with
   the **extension**. `file.mimetype` is whatever the client declared, so it is
   never the final word.

The Office formats are the subtle case: `.docx`/`.pptx` are ZIP containers and
their legacy `.doc`/`.ppt` counterparts are OLE2 compound files, so both
families are accepted for those extensions — and neither is accepted for `.png`.

A refusal answers `400 Unsupported or invalid file type.` and nothing more. What
was declared, what was detected and why it was refused go to the security log,
where they are useful, rather than to the uploader, who would use them to find
what does get through.

---

## 2. Submit — claiming the staged files

`POST /documents` · guard `JwtAuthGuard` · rate tier `upload`

The form sends metadata plus `staged_file_ids`. The same endpoint also accepts
files in the multipart body, so a client that never staged anything still works;
the two paths merge inside `uploadMany`.

Order matters here:

1. **Validate the shape** — global `ValidationPipe` with `whitelist` and
   `forbidNonWhitelisted`, so unknown fields are refused rather than ignored.
2. **Load the major, check the doc type** — `assertDocType` rejects a type that
   department cannot have (language courses and department courses offer
   different sets).
3. **Resolve the audience** — `resolveAudience` verifies every
   `(department, year)` pair really exists, and clears the audience entirely for
   a language course, since every student takes those.
4. **Create the `uploads` row** with `status: 'pending'`.
5. **Claim the files** — `claimStagedFiles` turns each staged row into a
   `documents` row and deletes the staged row.
6. **Notify reviewers** — `createForReviewers`, deliberately **not awaited**.

### Two details worth knowing

**Claiming is all-or-nothing.** Ids that are not yours, or were already claimed,
are rejected rather than skipped:

```ts
if (staged.length !== unique.length)
  throw new BadRequestException('Unknown staged file');
```

Skipping would let a bad payload produce an upload with no files in it.

**The notification is fire-and-forget.** The upload is already saved and the
student is waiting on the response. A reviewer who is not told still has the
queue in front of them; a student who sees an error because a notification
failed has lost their upload for no reason.

---

## 3. Review — where "uploaded" becomes "published"

A new upload lands `pending`, which means:

- it is **not in the feed** — not even for its own uploader
- the uploader sees it on their dashboard, badged **Under review**
- moderators of that department see it in their queue

`PATCH /admin/documents/group/:id/approve` flips `uploads.status` to `active`
and stamps `reviewed_by`. Reject sets `rejected` with a reason.

Authorisation is per-resource, not per-route: the department comes from the
**upload**, so the id in the URL decides _which_ upload is checked, never
_whether_ it is.

```ts
this.moderation.assertCanModerate(reviewer, upload.major_id);
```

---

## 4. Reading a file — the `documents` bucket is private

Nothing in the `documents` bucket is reachable by URL. `mc anonymous set none`
is applied at bucket creation, so a raw object URL answers **403** no matter who
holds it. The only way in is a presigned URL the API mints, and it mints one
only after authorising the caller.

```
GET /documents/files/:fileId/download     the original, as an attachment
GET /documents/files/:fileId/preview      the generated PDF, inline
```

`signFileAccess()` runs the checks in this order, and the order is
load-bearing:

```
load the file  →  load its upload  →  canView(audience/expiry/hidden)
               →  upload status    →  this file's own status
               →  THEN sign
```

Signing before authorising would mint a working URL for a caller about to be
refused — and a presigned URL is a bearer token that cannot be recalled for its
lifetime. Nothing in that method touches storage until every check has passed.

Refusals are **404**, matching `findOne()`: a document you may not see must not
be distinguishable from one that does not exist.

### Why list responses still carry URLs

`file_url` in a feed or review response is now a **signed, expiring** URL rather
than a permanent address. Those rows have already been through the audience
filter, so signing them is covered by the same decision that returned them, and
S3v4 presigning is a local HMAC — no round trip — so a page of two dozen files
costs microseconds.

They expire (`S3_SIGNED_URL_TTL_SECONDS`, default 300). That is why
click-to-download goes through the endpoint instead: it re-authorises and mints
a fresh link at the moment of the click.

> Signing uses a second S3 client bound to `S3_PUBLIC_URL`. An S3v4 signature
> covers the host, so a URL signed against the internal `S3_ENDPOINT`
> (`http://minio:9000` in Docker) is unreachable from a browser. Uploads and
> deletes still use the internal client.

### Storage keys

`documents.storage_key` / `preview_key` hold the canonical `"<bucket>/<key>"`
ref and are what every read resolves. `file_url` is kept for legacy rows and as
the backfill source — **it is not an authorisation mechanism**.

Keys are `<prefix>/<uuid>.<ext>`, generated server-side. They carry no part of
the uploader's filename, which lives only in `original_name`. Nothing derived
from user input reaches a storage path, and `parseRef` / `isSafeKeySegment`
refuse anything containing `..`, a leading slash, a backslash or a control
character before it can reach S3.

---

## 5. Adding files to an existing document

`POST /documents/:id/files` — uploader only. Accepts staged ids, multipart
files, or both, exactly like the create path.

The new files' status depends on what they are being added to:

| Upload status          | New file status | Why                                                                                                                                                                                                        |
| ---------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active` (approved)    | `pending`       | The file has never been reviewed. It stays hidden from everyone but the uploader, while the rest of the document stays visible — hiding one attachment must not pull an approved document out of the feed. |
| `pending` / `rejected` | `active`        | The upload's own review covers everything in it as a group.                                                                                                                                                |

Editing an upload that is not yet approved sends it back for review:
`status: 'pending'`, `rejection_reason: null`.

The response carries `needs_review`, so the client can say _"1 file added —
waiting for review"_ rather than implying it is live.

---

## Limits

| Limit                  | Value                        | Enforced at                                    |
| ---------------------- | ---------------------------- | ---------------------------------------------- |
| File size              | 20 MB                        | Multer, per file                               |
| Files per request      | 10                           | `FilesInterceptor`                             |
| Upload requests        | 60 per 10 min, per user      | rate tier `upload`                             |
| Staged file lifetime   | 24 h                         | `purgeStaleStaged`, on next stage              |
| Total bytes per user   | 200 MB / hour (configurable) | `UploadQuotaService` → 429 + `Retry-After`     |
| Image dimensions       | 1920 px longest edge         | Sharp, re-encoded                              |
| Image decode ceiling   | 50 MP                        | Sharp `limitInputPixels` — decompression bombs |
| Presigned URL lifetime | 300 s (clamped 30–600)       | `S3_SIGNED_URL_TTL_SECONDS`                    |

---

## Failure behaviour

| Failure                         | Result                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| Storage put fails               | `500`, nothing recorded                                                 |
| Staged row fails to save        | objects removed, `500` — no orphan in storage                           |
| Office conversion fails         | upload succeeds, `preview_url` null                                     |
| Unknown / foreign staged id     | `400`, no upload created                                                |
| Bytes fail signature validation | `400` generic message; detail to the log only                           |
| Malware detected                | `400`; nothing written. The signature name goes to the log only         |
| Scanner unreachable             | `503`, retryable; nothing written — fail closed, never stored unscanned |
| Byte quota exhausted            | `429` with `Retry-After`; nothing written                               |
| Image is a decompression bomb   | refused before decoding                                                 |
| Image optimisation fails        | original bytes stored — a sharp failure does not cost an upload         |
| Bad `major_id` / `subject_id`   | FK violation mapped to `400`                                            |
| Notification fails              | upload unaffected                                                       |

---

## Where the code lives

| Piece                                                     | File                                            |
| --------------------------------------------------------- | ----------------------------------------------- |
| Endpoints, Multer config, limits                          | `src/modules/documents/documents.controller.ts` |
| `stageFile`, `claimStagedFiles`, `uploadMany`, `addFiles` | `src/modules/documents/documents.service.ts`    |
| Object put/remove, bucket names, public URL               | `src/modules/storage/storage.service.ts`        |
| Office → PDF preview                                      | `src/modules/storage/office-convert.service.ts` |
| Filename decoding                                         | `src/modules/documents/utils/upload-name.ts`    |
| Malware scanning                                          | `src/common/security/clamav.service.ts`         |
| Approve / reject                                          | `src/modules/admin/admin.service.ts`            |

---

## Malware scanning

`clamd` runs as its own container and is reached over TCP on 3310. The API
streams each uploaded buffer to it with INSTREAM, after the magic-byte check
and before the object is written, so an infected file never reaches storage.

**The original bytes are what get scanned**, not the optimised ones. That is
what the uploader sent, and for everything except images it is also exactly
what will be stored.

### Fail closed, deliberately

If clamd cannot be reached, the upload is refused with `503` — it is not stored
unscanned. Once a file is in the bucket nothing marks it as having skipped the
scanner, so "the scanner was down" would silently become "this file is fine".

The escape hatch is explicit: `CLAMAV_ENABLED=false` turns scanning off
entirely, and logs a warning on every boot. Either the control is there or it
has been switched off on purpose; it is never quietly absent.

Two deadlines, not one. `CLAMAV_CONNECT_TIMEOUT_MS` (3 s) covers reaching
clamd; `CLAMAV_TIMEOUT_MS` (30 s) covers the scan itself. Conflating them is
expensive in exactly the case that matters: a stopped container drops packets
rather than refusing them, so without a separate connect deadline every upload
waits the full scan timeout before failing. Measured: 30 s → 3 s.

### Verifying it works

Use EICAR — the industry-standard harmless test signature, not malware:

```bash
printf 'X5O!P%%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > eicar.com
zip eicar.zip eicar.com          # .zip is an accepted type; clamd unpacks it
# upload eicar.zip  -> 400 "This file was rejected by the malware scanner."
```

Wrap it in a **zip**, not a PDF. clamd parses a PDF structurally and will not
find the signature pasted into one — that returns `OK`, which looks like a
broken scanner and is not. Archives are unpacked and scanned, so a zip is the
honest end-to-end check.

### Operational notes

- The image is `clamav/clamav-debian`, not `clamav/clamav`: the Alpine variant
  publishes amd64 only, and this has to run on both an Apple Silicon laptop and
  an x86 server.
- The signature database lives in the `clamav-data` volume. Without it,
  freshclam re-downloads ~250 MB on every container create — slow, and ClamAV's
  mirrors rate-limit, which can leave a scanner with no database at all.
- clamd holds the database in memory (~1 GB). Budget for it.
- First boot takes a few minutes before clamd answers; the compose healthcheck
  has a 300 s `start_period` and the backend waits on it.

## Known gaps

1. **Office previews trust LibreOffice with the file.** Conversion runs with a
   60 s timeout in an isolated temp directory and a failure only costs the
   preview, but the converter itself parses untrusted input, and it runs
   _after_ the scan. Sandboxing it (a container with no network, a seccomp
   profile) would bound that.

2. **The three image buckets are still public-read.** `user-avatar`,
   `subject-cover` and `book-covers` hold non-sensitive images rendered by plain
   `<img>` tags throughout the client. Closing them needs a read path of their
   own — either presigned URLs threaded through every serializer that returns an
   avatar or cover, or a streaming proxy endpoint. Smaller exposure than
   `documents` was, and explicitly **not** claimed as done.

3. **The byte quota is in memory.** Correct for one backend instance; a second
   replica would grant the full quota independently, making the effective limit
   N × the configured one. Same caveat and same fix as the rate limiter — move
   to Redis before scaling out. See `docs/rate-limiting.md`.

4. **Office previews trust LibreOffice with the file.** Conversion runs with a
   60 s timeout in an isolated temp directory and a failure only costs the
   preview, but the converter itself parses untrusted input. Sandboxing it
   (a container with no network, a seccomp profile) would bound that.

5. **Nothing reconciles storage against the database.** Deletes remove the
   object and the row together, and a failed upload rolls its object back — but
   a crash between the two still leaves an orphan, and nothing sweeps for one.
   `idx_documents_storage_key` exists to make that sweep cheap when it is
   written: list the bucket, subtract the keys the table knows about, and the
   remainder is garbage. **Not implemented** — the index is groundwork, not the
   job.
