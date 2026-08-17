# Model licenses and provenance

The runtime model files are intentionally excluded from Git. They must be
published as immutable release assets with the same AGPL-3.0 license notice,
hashes, model cards, and source/export information before the npm package is
published.

## `recaptcha_classification_57k.onnx`

- Source: <https://huggingface.co/DannyLuna/recaptcha-classification-57k>
- Local size: `113597179` bytes
- SHA-256: `4092e8917ee8c2963895d66ba10a97d6ef975c468a95858a8a7bd9e70681b65d`
- ONNX producer: `pytorch`
- Embedded description: `Ultralytics YOLO11x-cls model trained on dataset_cls`
- Embedded Ultralytics version: `8.3.235`
- Embedded license: `AGPL-3.0 License (https://ultralytics.com/license)`
- Runtime input: dynamic batch, `3 x height x width`
- Runtime output: 14-class probability vector

## `yolo12x.onnx`

- Source checkpoint: <https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo12x.pt>
- Export recipe: [`packaging/prepare_models.py`](packaging/prepare_models.py)
- Local size: `236935712` bytes
- SHA-256: `dcc6c1dba37f52ea8c265e059f8bafa42caf237a1e4c20fbb49a93560214d707`
- ONNX producer: `pytorch`
- Embedded description: `Ultralytics YOLOv12x model`
- Embedded Ultralytics version: `8.3.241`
- Embedded license: `AGPL-3.0 License (https://ultralytics.com/license)`
- Runtime input: `1 x 3 x 640 x 640`
- Runtime output: `1 x 84 x 8400`

## Release gate

Do not publish either model until the release contains:

1. An immutable URL, byte size, and SHA-256 for every asset.
2. The complete AGPL-3.0 license text and this provenance record.
3. Model cards describing inputs, outputs, class mappings, and limitations.
4. Public build/export scripts and pinned source checkpoints.
5. A completed training-dataset provenance review.
