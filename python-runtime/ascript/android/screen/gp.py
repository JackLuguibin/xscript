"""Image-processing pipeline ("图色插件") base classes, compatible with AScript's gp module."""

from abc import ABC, abstractmethod


class Result:
    def __init__(self, image, offset_x=0, offset_y=0, data=None):
        self.image = image
        self.offset_x = offset_x
        self.offset_y = offset_y
        self.data = data


class GPTask(ABC):
    name = "插件名称"
    ui_path = "插件UI地址"

    @abstractmethod
    def run(self, cv_image, offset_x=0, offset_y=0, data=None) -> Result:
        pass


class GPStack:
    """Run tasks in order; each task receives the previous task's image and offsets."""

    @staticmethod
    def run_json(json_param):
        return None

    def __init__(self, cv_image=None):
        self.gp_dao = []
        self.image = cv_image
        self.offset_x = 0
        self.offset_y = 0
        if self.image is None:
            from ascript.android import screen

            self.image = screen.bitmap_to_cvimage()

    def add(self, dao):
        self.gp_dao.append(dao)
        return self

    @staticmethod
    def change_img_channal(cv_image):
        import cv2

        if cv_image.ndim == 2:
            return cv2.cvtColor(cv_image, cv2.COLOR_GRAY2BGR)
        if cv_image.shape[2] == 4:
            return cv2.cvtColor(cv_image, cv2.COLOR_BGRA2BGR)
        return cv_image

    def run(self):
        image, ox, oy, data = self.image, self.offset_x, self.offset_y, None
        res = Result(image, ox, oy, data)
        for task in self.gp_dao:
            res = task.run(image, ox, oy, data)
            image, ox, oy, data = res.image, res.offset_x, res.offset_y, res.data
        return res


def run(gp_file, cv_img=None):
    raise NotImplementedError("gp files from AScript's 图色工具 are not supported by XScript")
