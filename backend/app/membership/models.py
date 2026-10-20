from pydantic import Field

from ..common.models import Payload


class InviteCode(Payload):
    code: str = Field(min_length=1, max_length=256)


class DisabledUpdate(Payload):
    is_disabled: bool
