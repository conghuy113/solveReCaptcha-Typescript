# reCAPTCHA classification model card

- File: `recaptcha_classification_57k.onnx`
- Task: classification of square reCAPTCHA image tiles
- Input: RGB float tensor in NCHW layout; dynamic batch; images resized and
  center-cropped to `640 x 640`; values normalized to `[0, 1]`
- Output: probability vectors for 14 classes, in the order recorded by the
  TypeScript `CLASS_NAMES` constant
- License: AGPL-3.0-only

The model is intended for local inference and may be inaccurate on new image
styles, low-resolution tiles, occluded objects, or classes outside its training
set. Callers must apply an application-appropriate confidence threshold. The
training-data review status is documented in `DATASET_PROVENANCE.md`.
