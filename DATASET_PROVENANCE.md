# Training dataset provenance

This document records the current state of the training-data review. It is not
a representation that every underlying image is cleared for redistribution.

- Review status: **BLOCKED**
- Evidence review updated: 2026-08-17
- Release decision owner: repository maintainer

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

## Release gate

Before a public model release, maintainers must either:

- document an authorized, redistributable source for all required training
  data; or
- document why the model weights may be distributed without redistributing the
  underlying dataset, after an appropriate license review.

The evidence and conclusion must be committed here with the reviewer and review
date. Merely changing the status or typing the workflow attestation is not a
substitute for that record.

Until that review is complete, model assets remain blocked from public release.
