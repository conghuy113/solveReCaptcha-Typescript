# Third-party notices

This project is distributed under the GNU Affero General Public License v3.0.
The following notices identify direct upstream works and model assets whose
copyright and license notices must be preserved.

## Preserved MIT notices

Portions of this repository are derived from MIT-licensed upstream works. The
required original copyright and permission notices are preserved in
[`LICENSES/vision-ai-recaptcha-solver-MIT.txt`](LICENSES/vision-ai-recaptcha-solver-MIT.txt)
and
[`LICENSES/recaptcha-domain-replicator-MIT.txt`](LICENSES/recaptcha-domain-replicator-MIT.txt).

## Ultralytics model assets

The current classification and detection ONNX files identify themselves as
Ultralytics models licensed under AGPL-3.0. Their exact provenance, hashes, and
runtime metadata are recorded in [`MODEL_LICENSES.md`](MODEL_LICENSES.md).

## Other dependencies

The TypeScript runtime directly depends on
[`onnxruntime-node`](https://www.npmjs.com/package/onnxruntime-node) and
[`ws`](https://www.npmjs.com/package/ws), licensed under MIT, and
[`sharp`](https://www.npmjs.com/package/sharp), licensed under Apache-2.0.
These dependencies retain their own copyright and license notices inside their
distributions. Sharp's platform packages also deliver libvips components under
LGPL-3.0-or-later.

Maintainer-only model-release tools use their declared Python dependencies;
they are not part of the installed npm runtime. All dependencies retain their
own copyright and license terms. CI generates and policy-checks a dependency
license inventory and CycloneDX SBOM from the exact packed npm artifact before
publication; the release workflow attaches both records to the GitHub Release.
