# Training dataset provenance

This document records the current state of the training-data review. It is not
a representation that every underlying image is cleared for redistribution.

## Classification model

The upstream model card links to
<https://huggingface.co/datasets/DannyLuna/recaptcha-57k-images-dataset>, whose
repository is labelled MIT. The current workspace does not contain the dataset,
the collection procedure, source-image permissions, or a per-source license
inventory. A repository-level MIT label alone does not establish that the
uploader owns or can relicense every underlying image.

## Detection model

`yolo12x.onnx` is exported from the Ultralytics `yolo12x.pt` checkpoint. The
checkpoint, model architecture, training-data disclosures, and applicable
license notices must be documented in the public model release.

## Release gate

Before a public model release, maintainers must either:

- document an authorized, redistributable source for all required training
  data; or
- document why the model weights may be distributed without redistributing the
  underlying dataset, after an appropriate license review.

Until that review is complete, model assets remain blocked from public release.
