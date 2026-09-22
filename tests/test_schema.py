import pytest

import janus


def test_schema_maps_scalar_types_and_requires_every_field():
    schema = janus.build_schema({"a": "str", "b": "int", "c": "float", "d": "bool"})
    assert schema == {
        "type": "object",
        "properties": {"a": {"type": "string"}, "b": {"type": "integer"}, "c": {"type": "number"},
                       "d": {"type": "boolean"}},
        "required": ["a", "b", "c", "d"],
        "additionalProperties": False,
    }


def test_schema_one_of_becomes_a_string_enum():
    schema = janus.build_schema({"verdict": {"one_of": ["pass", "fail"]}})
    assert schema["properties"]["verdict"] == {"type": "string", "enum": ["pass", "fail"]}


def test_schema_list_of_scalars():
    schema = janus.build_schema({"files": "list[str]", "sizes": "list[int]"})
    assert schema["properties"]["files"] == {"type": "array", "items": {"type": "string"}}
    assert schema["properties"]["sizes"] == {"type": "array", "items": {"type": "integer"}}


def test_schema_list_of_mappings_is_a_one_element_yaml_sequence():
    schema = janus.build_schema({"tasks": [{"id": "int", "title": "str"}]})
    assert schema["properties"]["tasks"] == {
        "type": "array",
        "items": {"type": "object", "properties": {"id": {"type": "integer"}, "title": {"type": "string"}},
                  "required": ["id", "title"], "additionalProperties": False},
    }


def test_schema_nested_mapping_is_a_strict_object():
    schema = janus.build_schema({"build": {"status": {"one_of": ["SUCCESS", "FAILURE"]}, "url": "str"}})
    assert schema["properties"]["build"] == {
        "type": "object",
        "properties": {"status": {"type": "string", "enum": ["SUCCESS", "FAILURE"]}, "url": {"type": "string"}},
        "required": ["status", "url"],
        "additionalProperties": False,
    }


@pytest.mark.parametrize("output", [
    {"a": "text"}, {"a": "list[thing]"}, {"a": []}, {"a": {}}, {"a": {"one_of": []}}, {}, "str"])
def test_schema_rejects_invalid_declarations(output):
    with pytest.raises(janus.JanusError, match="invalid output declaration"):
        janus.build_schema(output)


def test_validate_requires_exactly_the_declared_keys():
    schema = janus.build_schema({"a": "str", "b": "int"})
    assert janus.validate({"a": "x", "b": 1}, schema) is None
    assert janus.validate({"a": "x", "c": 1}, schema) == "$: expected exactly the keys ['a', 'b'], got ['a', 'c']"
    assert janus.validate(["a"], schema) == "$: expected object"


def test_validate_reports_wrong_types_and_enum_values_with_their_path():
    schema = janus.build_schema({"tasks": [{"id": "int", "state": {"one_of": ["todo", "done"]}}], "ok": "bool"})
    good = {"tasks": [{"id": 1, "state": "todo"}], "ok": True}
    assert janus.validate(good, schema) is None
    assert janus.validate({"tasks": [{"id": True, "state": "todo"}], "ok": True}, schema) == \
        "$.tasks[0].id: expected integer"
    assert janus.validate({"tasks": [{"id": 1, "state": "maybe"}], "ok": True}, schema) == \
        "$.tasks[0].state: expected string in ['todo', 'done']"
    assert janus.validate({"tasks": [], "ok": 1}, schema) == "$.ok: expected boolean"
    assert janus.validate({"tasks": {}, "ok": True}, schema) == "$.tasks: expected array"
