import os
from pathlib import Path

from copier_template_extensions import ContextHook


def _has_file(dst, pattern):
    return next(Path(dst).rglob(pattern), None) is not None


class DetectStack(ContextHook):
    def hook(self, context):
        dst = context["_copier_conf"]["dst_path"]
        detected = []
        if os.path.exists(os.path.join(dst, "Cargo.toml")):
            detected.append("rust")
        if os.path.exists(os.path.join(dst, "pyproject.toml")):
            detected.append("python")
        is_frontend = (
            os.path.exists(os.path.join(dst, "package.json"))
            or _has_file(dst, "*.js")
            or _has_file(dst, "*.ts")
        )
        if is_frontend:
            detected.append("frontend")
        if os.path.exists(os.path.join(dst, ".github", "workflows")):
            detected.append("gha")
        if _has_file(dst, "*.sql"):
            detected.append("sql")
        if _has_file(dst, "*.sh"):
            detected.append("shell")
        if not is_frontend and _has_file(dst, "*.json"):
            detected.append("json")
        context["_stack_detected"] = detected
        return context
