import os

from copier_template_extensions import ContextHook


class DetectStack(ContextHook):
    def hook(self, context):
        dst = context["_copier_conf"].dst_path
        detected = []
        if os.path.exists(os.path.join(dst, "Cargo.toml")):
            detected.append("rust")
        if os.path.exists(os.path.join(dst, "pyproject.toml")):
            detected.append("python")
        if os.path.exists(os.path.join(dst, "package.json")):
            detected.append("node")
        context["_stack_detected"] = detected
        return context
