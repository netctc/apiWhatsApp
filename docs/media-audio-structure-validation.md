# Bounded audio structure validation

Non-ISO audio uploads use a file-aware structural gate after the existing bounded signature precheck. The objective is to reject prefix-only, truncated, malformed-frame, and simple appended-data inputs before retained storage, malware scanning, sender credential resolution, `MediaAsset` reservation, or Meta upload.

This validation covers:

```text
audio/ogg
audio/aac
audio/mpeg
audio/amr
```

`audio/mp4` remains covered by the ISO-BMFF structural validator.

This layer validates container and frame boundaries. It is not a codec decoder, transcoder, or media sanitizer.

## Ogg

The Ogg validator traverses the physical bitstream page by page and requires:

- the `OggS` capture pattern on every page;
- stream-structure version `0`;
- no unknown page-header flag bits;
- a beginning-of-stream page with sequence number `0` for each logical stream;
- page sequence continuity per logical stream;
- consistency between the continued-packet flag and the preceding page's final lacing value;
- page length derived from the segment table to remain inside the file and the Ogg maximum page size;
- a valid Ogg CRC-32 for every page, calculated with the checksum field zeroed;
- no page after an end-of-stream page for the same logical stream;
- every logical stream to finish with EOS and no unfinished continued packet;
- exact traversal to EOF with at least one payload byte;
- fewer than 100,000 pages.

The generic `matchesOggStructure(filePath)` helper remains codec-neutral. Uploads do not use that helper alone: `matchesAudioStructure(filePath, "audio/ogg")` enables the additional mono Opus profile below during the same page traversal.

### Mono Opus upload profile

`audio/ogg` uploads require one logical Opus stream with these properties:

- an exact 19-byte `OpusHead` identification packet, version `1`, one output channel, and mapping family `0`;
- the identification packet alone on the first BOS page, with granule position `0`;
- an `OpusTags` comment packet next, with all vendor, comment-count, and individual comment-length fields inside the packet;
- the comment packet ending its page, with granule position `0`;
- at least one complete, structurally valid Opus audio packet before EOS;
- no chained or multiplexed streams, empty pages, or zero-octet audio packets.

The packet assembler accepts headers and audio continued across pages. The identification packet is the exception: it must be complete on the first page. A page containing no complete packet must have granule position `-1`; a page completing audio packets must have a nonnegative granule position. Existing Ogg CRC, sequence, continuation, EOF, and EOS checks still apply.

Resource bounds are application policy:

| Resource | Limit |
| --- | --- |
| Reused packet assembly buffer | 64 KiB |
| Complete OpusTags packet, including optional trailing bytes | 64 KiB |
| Complete audio packet | 61,440 bytes |
| Audio packets per upload | 100,000 |
| Compressed bytes per Opus frame | 1,275 |
| Declared audio duration per packet | 120 ms |

Audio packet validation implements the four RFC 6716 framing codes, fixed- and variable-length frames, one- and two-byte frame lengths, frame-count limits, and padding. Legal zero-byte PLC/DTX frames within nonempty packets remain accepted. The identification header declares one output channel; the encoded packet's stereo bit is not forced to zero, because encoded channels and output channels are distinct in the Ogg Opus mapping.

OpusTags trailing padding or unspecified binary data is permitted within the bounded packet. Metadata strings are not decoded, interpreted, or logged by this gate.

### Compatibility and limits

This is a deliberately restricted upload profile, not a claim to accept every valid Ogg or Opus file. Previously accepted generic Ogg containers, other codecs such as Vorbis, stereo-output streams, future/minor Opus header versions, other mapping families, chained streams, and oversized metadata are now rejected for `audio/ogg`. The version-1-only, mono/family-0, single-stream, empty-page, and resource restrictions are application admission decisions, not universal requirements of the format.

The validator checks packet framing, not compressed sample contents. It does not decode or transcode audio, certify playability, validate the complete granule timeline or pre-skip/end-trim relationship, calculate whole-file duration, or replace malware scanning. Provider acceptance still depends on the provider's current media contract.

No new dependency, endpoint, environment variable, or database migration is required. Invalid input follows the existing `MediaContentSignatureError` path before downstream side effects.

References: [RFC 7845, Ogg Encapsulation for the Opus Audio Codec](https://www.rfc-editor.org/rfc/rfc7845.html), especially sections 3, 5, and 6; [RFC 6716, Opus packet framing](https://www.rfc-editor.org/rfc/rfc6716.html#section-3).

### Opus regression tests

Run the profile and packet-framing tests with the repository's normal test runner:

```bash
npm test -- test/media-ogg-opus-profile.spec.ts
```

The tests exercise the real MIME dispatcher with checksum-valid generated fixtures, including malformed headers, bounded metadata, continuation, missing EOS, foreign codecs, chain/multiplex rejection, packet framing, duration and size limits, and the existing container integrity gates. The generic container helper is tested separately to preserve its codec-neutral contract. Full repository lint, build, unit, integration, security, and Docker gates remain required before merge.

## AAC

### ADTS

ADTS validation walks frames to EOF and requires:

- the 12-bit sync word;
- AAC layer bits set to zero;
- a defined sampling-frequency index from 0 through 12, rejecting reserved indices 13 and 14 plus escape index 15;
- a 7-byte header when CRC is absent or a 9-byte header when CRC is present;
- declared frame length greater than its header length;
- every declared frame to remain inside the file;
- exact traversal to EOF;
- at most 100,000 frames.

The two-byte ADTS CRC field is required to be present when signalled, but this slice does not recompute the codec CRC.

### ADIF

ADIF validation parses a bounded prefix of at most 64 KiB and requires:

- the `ADIF` identifier;
- a complete optional copyright field when present;
- bitstream type, bitrate, and program-configuration count fields;
- all declared program configuration elements to fit inside the bounded header;
- a defined sampling-frequency index from 0 through 12;
- at least one configured audio channel element;
- structurally complete mixdown, element-tag, alignment, and bounded comment fields;
- data remaining after the parsed ADIF configuration header.

The raw AAC data blocks following the ADIF header are not decoded.

## MPEG audio

The MPEG audio validator supports the existing `audio/mpeg` identity and requires at least one complete MPEG audio frame.

It can skip:

- one ID3v2.2/v2.3/v2.4 tag at the beginning using its synchsafe declared size;
- one 128-byte ID3v1 `TAG` block at EOF.

Every audio frame must then have:

- the 11-bit sync pattern;
- a non-reserved MPEG version and layer;
- a defined non-zero bitrate index;
- a valid sample-rate index;
- non-reserved emphasis;
- a frame size derivable from version, layer, bitrate, sample rate, and padding;
- bytes available for the complete derived frame.

Frames are traversed exactly to the beginning of the optional ID3v1 tag, with a maximum of 100,000 frames.

Free-format MPEG audio (`bitrate_index = 0`) is deliberately rejected. Its frame size cannot be derived from the header alone and would require heuristic synchronization scanning, which is outside this bounded identity gate.

The validator does not decode MPEG audio samples, validate Layer III side information, recompute optional frame CRCs, or interpret Xing/VBRI/LAME data inside frame payloads.

## AMR and AMR-WB

The validator preserves the existing mono storage-file identities:

```text
#!AMR\n
#!AMR-WB\n
```

After the magic header, it walks storage frames according to the RFC 4867 frame-type tables and requires:

- frame-header padding bits to be zero;
- only defined AMR or AMR-WB frame types;
- the speech payload size derived from the frame type to remain inside the file;
- final speech-bit padding inside the last payload octet to be zero;
- exact traversal to EOF;
- at most 100,000 frames.

AMR narrowband accepts speech modes 0 through 7, SID frame type 8, and NO_DATA frame type 15. AMR-WB accepts speech modes 0 through 8, SID frame type 9, SPEECH_LOST frame type 14, and NO_DATA frame type 15. Reserved frame types are rejected.

This slice does not add multichannel AMR storage magic or decode speech frames.

## Processing order

The structural gate is part of the existing content-signature boundary:

```text
multipart temporary file
  -> declared MIME/size policy
  -> bounded signature precheck
  -> audio structural validation
  -> binary-storage planning/admission
  -> optional ClamAV scan
  -> sender credential resolution
  -> MediaAsset reservation
  -> retained storage when enabled
  -> Meta media upload
```

A structurally invalid file raises the existing `MediaContentSignatureError` path and does not reach downstream storage, scanning, secrets, registry, or provider calls.

## Security boundary

This gate deliberately does not:

- decode compressed audio samples;
- prove that every codec payload can be played by a decoder;
- transcode or normalize audio;
- inspect metadata semantics for malicious content;
- calculate loudness, duration, channel quality, or decoded-memory cost;
- replace malware scanning.

Optional ClamAV remains the malware boundary. Deeper codec-aware parsing, normalization, or asynchronous quarantine can be added later without weakening this bounded pre-provider gate.
