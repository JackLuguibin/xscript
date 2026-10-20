"""Template-matching entry points compatible with AScript's screen.ascv."""

from xscript.android import image as _img


def find_all_template(image_source, image_search, rect=None, threshold=0.5, rgb=False, maxcnt=0, bgremove=False,
                      ori=1, scale_range=None, fast=True):
    """`image_source` is a BGR ndarray already cropped to `rect` (rect is an offset only)."""
    if image_search is None or image_source is None:
        return None
    offset = (int(rect[0]), int(rect[1])) if rect else (0, 0)
    items = list(image_search) if isinstance(image_search, (list, tuple)) else [image_search]
    out = _img._match_many(_img.to_bgr(image_source), items, None, threshold, rgb, maxcnt, scale_range, offset, fast)
    return _img.sort_by_ori(out, ori)


find_all_template_cvimg = find_all_template


def find_all_sift(image_source, image_search, rect=None, threshold=0.5, rgb=False, maxcnt=0):
    """Keypoint matching (ORB, then SIFT, + homography): finds scaled and rotated targets. Templates with too
    little texture for keypoints (small flat icons) fall back to template matching, as before."""
    if image_search is None or image_source is None:
        return None
    offset = (int(rect[0]), int(rect[1])) if rect else (0, 0)
    items = list(image_search) if isinstance(image_search, (list, tuple)) else [image_search]
    src = _img.to_bgr(image_source)
    out = []
    for i, part in enumerate(items):
        hits = _img._feature_hits(src, [part], _img._clamp_confidence(threshold), offset, ("orb", "sift"), i)
        if not hits:
            hits = _img._match_many(src, [part], None, threshold, rgb, maxcnt, None, offset, True, first_index=i)
        out.extend(hits)
    return _img.sort_by_ori(out, 1)


def find_surf(image_source, image_search, threshold=0.5, off_rect=None, rgb=False, maxcnt=0):
    """SURF is patented and not in OpenCV's main module; same keypoint search as find_all_sift."""
    return find_all_sift(image_source, image_search, off_rect, threshold, rgb, maxcnt)
