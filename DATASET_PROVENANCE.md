# Training dataset provenance

This document records the current state of the training-data review. It is not
a representation that every underlying image is cleared for redistribution.

- Review status: **APPROVED FOR MODEL-WEIGHT RELEASE**
- Evidence review updated: 2026-08-17
- Release decision owner: conghuy113

## Classification model

The upstream model card identifies a 57k-image dataset and links to
<https://huggingface.co/datasets/DannyLuna/recaptcha-57k-images-dataset>. Both
the model and dataset repositories are labelled MIT. The public dataset card,
files, preview, and discussions reviewed on 2026-08-17 do not document the
image collection procedure, original source URLs, source-image permissions, or
a per-source license inventory. A repository-level MIT label alone does not
establish that the uploader owns or can relicense every underlying image.

## Detection model

`yolo12x.onnx` is exported reproducibly from the pinned Ultralytics
`yolo12x.pt` checkpoint. Ultralytics documents its pretrained detection models
against the COCO object-detection dataset, and the checkpoint/model metadata
declares AGPL-3.0. The exact checkpoint URL, digest, export recipe, model card,
and license notice are staged by the model-release workflow. This does not
resolve the separate classification-dataset gap above.

## Release decision

The repository maintainer reviewed the available dataset card, model card,
repository metadata, model metadata, and declared licenses on 2026-08-17. The
image-level provenance limitations described above remain unresolved. The
maintainer nevertheless accepts that residual risk and approves distribution
of the trained model weights under AGPL-3.0-only.

The model release does not redistribute the training dataset. This approval is
a release decision based on the public evidence currently available; it is not
a representation that every underlying training image has been individually
cleared for redistribution.

Any later evidence that materially changes this assessment must trigger a new
review before another model-set version is published.
