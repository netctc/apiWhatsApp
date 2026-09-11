# Bounded ISO-BMFF media validation

MP4 and 3GPP media uploads use a structured ISO Base Media File Format gate instead of accepting any prefix that merely contains the text `ftyp`.

This validation covers the container boundary for:

```text
audio/mp4
video/mp4
video/3gpp
```

It is intentionally not a codec decoder or a complete ISO/IEC 14496-12 parser.

## File-type box identity

The bounded prefix gate parses real top-level box headers and requires a structurally valid `ftyp` box. The validator accepts only small fixed-size `free`, `skip`, or `wide` boxes before `ftyp`; arbitrary or variable media boxes may not precede the file-type declaration.

The `ftyp` box must:

- have a valid 32-bit or 64-bit ISO-BMFF box size;
- fit completely inside the 8 KiB media signature prefix already read by the upload pipeline;
- be at most 4 KiB;
- contain a four-byte major brand and a four-byte minor-version field;
- contain only complete four-byte compatible-brand entries;
- use printable four-character codes for the box type and brands.

For `audio/mp4` and `video/mp4`, at least one major/compatible brand must identify a common MP4/ISO/CMAF family accepted by the service. The allowlist includes core ISO/MP4 brands such as `isom`, `iso2` through current ISO version brands, `mp41`, `mp42`, `avc1`, common iTunes MP4 audio/video brands, and selected CMAF/MP4 ecosystem brands.

For `video/3gpp`, at least one major/compatible brand must be a 3GPP family brand such as `3gp4`, `3gp5`, `3gp6`, `3gr6`, or later registered 3GPP variants. 3GPP2 branding such as `3g2a` does not satisfy the `video/3gpp` gate.

The MP4 Registration Authority documents brand identifiers used by the file-type box. 3GPP specifications additionally require 3GP files to carry 3GPP branding and, for later releases, commonly include `isom` as a compatible brand.

## Full-file top-level structure

After the prefix identity gate, the file-aware check walks top-level box headers by offset. It does not read or copy media payload bodies.

The file must contain:

```text
ftyp
moov
mdat
```

`moov` and `mdat` may appear in either order after `ftyp`. Other well-sized top-level boxes are skipped using their declared lengths. A second top-level `ftyp` is rejected.

The traversal supports:

- normal 32-bit box sizes;
- extended 64-bit box sizes that fit JavaScript safe integer and file bounds;
- a zero-sized final box meaning "extends to EOF";
- at most 4,096 top-level boxes.

The validator rejects boxes whose declared lengths are smaller than their headers, exceed the remaining file, use non-printable box types, or leave unparsed trailing bytes.

Requiring both `moov` and `mdat` prevents a bare `ftyp` box or a typical still-image ISO-BMFF container from satisfying the audio/video upload boundary. It also rejects truncated files whose top-level layout cannot be traversed coherently.

## Processing order

ISO-BMFF structural validation runs inside the existing media content-signature boundary:

```text
multipart temporary file
  -> declared MIME/size policy
  -> structured ftyp prefix identity
  -> full-file top-level ISO-BMFF structure walk
  -> binary-storage planning/admission
  -> optional ClamAV scan
  -> sender credential resolution
  -> MediaAsset reservation
  -> retained storage when enabled
  -> Meta media upload
```

An invalid MP4/3GPP container therefore does not reach storage staging, malware scanning, credential resolution, registry reservation, or Meta provider access.

The public failure mapping is unchanged: rejected containers use the existing media content-signature mismatch response.

## Security boundary

This validator deliberately does **not**:

- parse `moov` children or track tables;
- determine whether the file contains audio, video, or both;
- validate codecs, sample entries, duration, dimensions, frame rate, bitrate, or channel layout;
- validate every media-data offset or sample size;
- decrypt protected media;
- decode media frames;
- detect malware.

Codec- and track-level validation remains future deeper media hardening. ClamAV remains the optional malware boundary.
