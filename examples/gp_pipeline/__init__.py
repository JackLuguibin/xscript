"""Run on XScript: crop a screenshot, threshold, detect and print contours."""
from ascript.android.screen.gp import GPStack

jobs = [
    {"id": "ascript.android.screen.gp_tasks.Crop", "data": {"params": "0, 0, 200, 200"}},
    {"id": "ascript.android.screen.gp_tasks.Threshold", "data": {"params": "128"}},
    {"id": "ascript.android.screen.gp_tasks.Canny", "data": {
        "params": "blur=0, draw=Canny.DRAW_NONE, area_range=[20, 0], approx=0.02, detect_shape=True"
    }},
]
result = GPStack.run_json(jobs)
print("Crop origin:", result.offset_x, result.offset_y)
for shape in result.data:
    print(shape)
# The same jobs can be saved as JSON in data.gp and used with gp.run(path).
