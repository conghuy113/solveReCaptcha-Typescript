# Third-party notices

This project is distributed under the GNU Affero General Public License v3.0.
The following notices identify direct upstream works and model assets whose
copyright and license notices must be preserved.

## VisionAIRecaptchaSolver upstream source

Parts of this repository are derived from
[`DannyLuna17/VisionAIRecaptchaSolver`](https://github.com/DannyLuna17/VisionAIRecaptchaSolver),
copyright 2025 Danny Luna and originally distributed under the MIT License.
The preserved notice is in
[`LICENSES/vision-ai-recaptcha-solver-MIT.txt`](LICENSES/vision-ai-recaptcha-solver-MIT.txt).

## RecaptchaDomainReplicator

The retired Python implementation was derived in part from
[`DannyLuna17/RecaptchaDomainReplicator`](https://github.com/DannyLuna17/RecaptchaDomainReplicator),
copyright 2025 Danny Luna and distributed under the MIT License. The preserved
notice is in
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
distributions.

Maintainer-only model-release tools use their declared Python dependencies;
they are not part of the installed npm runtime. All dependencies retain their
own copyright and license terms. A generated dependency-license inventory and
SBOM are release gates and must be reviewed before publishing the npm package.
