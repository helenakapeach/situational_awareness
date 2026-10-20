from typing import Annotated

from pydantic import Field, StringConstraints

from ..common.models import Payload

Title = Annotated[str, StringConstraints(min_length=3, max_length=120)]
PostBody = Annotated[str, StringConstraints(min_length=1, max_length=4000)]
ReplyBody = Annotated[str, StringConstraints(min_length=1, max_length=2000)]


class PostUpdate(Payload):
    title: Title
    body: PostBody


class PostCreate(PostUpdate):
    is_anonymous: bool = True


class ReplyUpdate(Payload):
    body: ReplyBody


class ReplyCreate(ReplyUpdate):
    is_anonymous: bool = False
    parent_reply_id: int | None = Field(default=None, gt=0)


class Feedback(Payload):
    body: ReplyBody
