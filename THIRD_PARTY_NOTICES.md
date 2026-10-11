# Map Data

## Natural Earth

The clipped basemap comes from Natural Earth 1:10m administrative country data.
Natural Earth data is public domain: https://www.naturalearthdata.com/about/terms-of-use/
The data source and its SHA-256 are recorded in data/basemap.geojson.
This is a small-scale outline, not a survey-grade map or a statement on borders.

## KyoshinEewViewerIngen Observation Point Metadata

The image-pixel correspondence is derived from ShindoObsPoints.mpk.lz4 in
https://github.com/ingen084/KyoshinEewViewerIngen
The pinned source URL and SHA-256 are recorded in data/monitor-points.json.
These community-maintained mappings are NOT an official NIED station feed.
The app matches station codes and geographic coordinates against its NIED
station catalog, rejects relocated/ambiguous mappings, and does not infer values
or earthquake detections from colors. Image colors are reproduced for display only.

MIT License

Copyright (c) 2019 ingen084

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## NIED Monitor Images

The local relay retrieves NIED images without modifying the source bytes.
Displaying image colors on another map is based on the user's stated permission.
That permission must cover image reuse/remapping before publication; it is not
conferred by the MIT metadata license or the J-SHIS API terms.
https://www.kyoshin.bosai.go.jp/ja/about_kmoni/

## User-Supplied Alarm Sound (nc239566)

The user supplied an MP3 identified by nc239566 and requested it as the alarm.
The unmodified file is used only in a separate local work copy as
audio/eew-alarm.mp3 (42,688 bytes). It is not part of this public repository,
Pages build, or Service Worker cache. The public app uses a generated tone.
SHA-256: 1d86344aba88a522aa6ffe9ff54a846e6df5b2b4bf2f5620c18321e879a41363
The author, source URL, license, and redistribution conditions are not verified.
No license or attribution requirement is inferred from the filename. The map
metadata MIT license above does not cover this audio. Verify the audio's terms
before redistributing the asset. The MP3 has not been uploaded with this release.
