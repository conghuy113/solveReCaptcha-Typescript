# YOLO12x detection model card

- File: `yolo12x.onnx`
- Source checkpoint: Ultralytics `yolo12x.pt`
- Export recipe: `packaging/prepare_models.py`
- Task: COCO object detection for square reCAPTCHA challenges
- Input: one RGB float tensor with shape `1 x 3 x 640 x 640`
- Output: raw tensor with shape `1 x 84 x 8400`; decoding and non-maximum
  suppression are performed by the solver
- License: AGPL-3.0-only

The model is intended for local inference. Its predictions may be incomplete or
incorrect for small, partially visible, unusual, or out-of-distribution objects.
The source, exact hash, and training-data review status are documented in
`MODEL_LICENSES.md` and `DATASET_PROVENANCE.md`.
