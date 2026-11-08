import json
import os

from django.contrib.auth.models import User
from django.test import Client, TestCase
from django.utils import timezone

from projects.migrations_data.ic_unification import (
    SCHEMA_VERSION,
    _X_NEW,
    _X_OLD,
    _apply_transform,
    _pin_offsets_for_def,
    _symbol_family,
    migrate_ic_unification,
)
from projects.migrations_data.optocoupler_v4 import migrate_optocoupler_v4
from projects.migrations_data.pipeline import CURRENT_SCHEMA_VERSION, migrate_to_current
from projects.migrations_data.schematic_v3 import SCHEMA_VERSION as V3, decide_wiring, migrate_schematic_v3
from projects.models import Branch, Project, UserBoard, UserPart


def _main(project):
    """The design the project's main branch holds now."""
    return Branch.objects.get(pk=Project.objects.get(pk=project.pk).main_branch_id).data


FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "ic-migration-test-project.json")


def _v1_dip8_payload():
    """Small inline v1-shape payload: one DIP-8 with a wire on pin 1."""
    return {
        "components": [{
            "id": "c1", "defId": "def-ic-dip8",
            "schematicPos": {"x": 200, "y": 200},
            "schematicRotation": 0, "label": "U1",
            "boardPos": None, "rotation": 0,
        }],
        "schematicWires": [{
            "id": "w1",
            "start": {"x": 150, "y": 180},  # old DIP-8 pin1 abs
            "end": {"x": 500, "y": 180},
            "routeDirection": "horizontal-first",
        }],
    }


def _wire(sx, sy, ex, ey, wire_id="w"):
    return {
        "id": wire_id,
        "start": {"x": sx, "y": sy},
        "end": {"x": ex, "y": ey},
        "routeDirection": "horizontal-first",
    }


def _comp(comp_id, def_id, x, y, *, rotation=0, mirrored=False):
    return {
        "id": comp_id,
        "defId": def_id,
        "schematicPos": {"x": x, "y": y},
        "schematicRotation": rotation,
        "schematicMirrored": mirrored,
        "label": "U1",
        "boardPos": None,
        "rotation": 0,
    }


class IcUnificationTests(TestCase):
    # ── Affected ICs ────────────────────────────────────────

    def test_dip8_pin1_wire_repointed(self):
        # DIP-8 at (200, 200), no rotation.
        # pins_per_side=4, extent=60, y_start=-20.
        # Pin 1 (left, top): old local (-50, -20) → new (-60, -20).
        # Absolute: old (150, 180) → new (140, 180).
        data = {
            "components": [_comp("c1", "def-ic-dip8", 200, 200)],
            "schematicWires": [_wire(150, 180, 500, 180)],
        }
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 140, "y": 180})
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 500, "y": 180})
        self.assertEqual(out["version"], SCHEMA_VERSION)

    def test_dip8_all_eight_pins(self):
        # Verify the full pin layout for DIP-8.
        # Left (x=-old, y=[-20,0,20,40]); Right (x=+old, y=[40,20,0,-20]).
        c = _comp("c1", "def-ic-dip8", 200, 200)
        wires = []
        for y in (-20, 0, 20, 40):
            wires.append(_wire(200 - 50, 200 + y, 999, 999, wire_id=f"L{y}"))
            wires.append(_wire(200 + 50, 200 + y, 999, 999, wire_id=f"R{y}"))
        data = {"components": [c], "schematicWires": wires}
        out, _ = migrate_ic_unification(data)
        # Every wire start should now sit at the new ±60 x position; ends untouched.
        for w in out["schematicWires"]:
            self.assertIn(w["start"]["x"], (140, 260))
            self.assertEqual(w["end"], {"x": 999, "y": 999})

    def test_555_rotated_90(self):
        # 555 pin 1 local (old): (-40, -20). Rotate 90°: (-y, x) = (20, -40).
        # 555 pin 1 local (new): (-60, -20). Rotate 90°: (20, -60).
        # At (100, 100): old abs (120, 60) → new abs (120, 40).
        data = {
            "components": [_comp("c1", "def-555", 100, 100, rotation=90)],
            "schematicWires": [_wire(120, 60, 999, 999)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 120, "y": 40})

    def test_555_mirrored(self):
        # 555 pin 1 local (old): (-40, -20). Mirror: (40, -20). Rotate 0: (40, -20).
        # 555 pin 1 local (new): (-60, -20). Mirror: (60, -20).
        # At (50, 50): old abs (90, 30) → new abs (110, 30).
        data = {
            "components": [_comp("c1", "def-555", 50, 50, mirrored=True)],
            "schematicWires": [_wire(999, 999, 90, 30)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 110, "y": 30})

    def test_optocoupler_unrelated_wires_untouched(self):
        # Opto at (300, 300). Pin 1 old local (-40, -20) → abs (260, 280).
        # Wire at (200, 200) → (250, 250): neither endpoint matches any pin.
        data = {
            "components": [_comp("c1", "def-optocoupler", 300, 300)],
            "schematicWires": [_wire(200, 200, 250, 250)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 200, "y": 200})
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 250, "y": 250})

    # ── Non-affected components ─────────────────────────────

    def test_resistor_wire_untouched(self):
        # Resistor is not in DEFAULT_IC_SYMBOLS.
        data = {
            "components": [_comp("r1", "def-resistor", 100, 100)],
            "schematicWires": [_wire(100, 80, 100, 120)],
        }
        out, _ = migrate_ic_unification(data)
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 100, "y": 80})
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 100, "y": 120})

    def test_resistor_at_old_ic_pin_position_unaffected(self):
        # Two components: a DIP-8 IC (will trigger remap at (150, 180))
        # and a resistor whose wire HAPPENS to terminate elsewhere.
        # Confirms we only build remap entries from affected IC components.
        data = {
            "components": [_comp("r1", "def-resistor", 999, 999)],
            "schematicWires": [_wire(150, 180, 200, 200)],
        }
        out, _ = migrate_ic_unification(data)
        # No IC in the project → no remap → wire untouched.
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 150, "y": 180})

    # ── Idempotency & shape edge cases ──────────────────────

    def test_idempotent_v2_data(self):
        data = {
            "version": 2,
            "components": [_comp("c1", "def-ic-dip8", 200, 200)],
            "schematicWires": [_wire(150, 180, 500, 180)],
        }
        out, changed = migrate_ic_unification(data)
        self.assertFalse(changed)
        # No mutation.
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 150, "y": 180})
        self.assertEqual(out["version"], 2)

    def test_missing_components_key(self):
        data = {"schematicWires": []}
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)

    def test_missing_wires_key(self):
        data = {"components": [_comp("c1", "def-ic-dip8", 200, 200)]}
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)

    def test_non_dict_data(self):
        out, changed = migrate_ic_unification("not a dict")
        self.assertFalse(changed)
        self.assertEqual(out, "not a dict")

    def test_null_schematic_pos_skipped(self):
        # Component with no schematicPos is skipped silently; version still stamped.
        comp = _comp("c1", "def-ic-dip8", 200, 200)
        comp["schematicPos"] = None
        data = {
            "components": [comp],
            "schematicWires": [_wire(150, 180, 500, 180)],
        }
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)
        # Wire shouldn't have moved (no remap entry for this component).
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 150, "y": 180})

    def test_empty_project(self):
        data = {}
        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)


class IcUnificationRealWorldTests(TestCase):
    """End-to-end tests against a real exported project, hand-built on the
    pre-migration live site. The fixture exercises all 3 affected IC families
    (generic-ic-N, timer-555, optocoupler) across every rotation (0/90/180/270)
    and both mirror states, with many wires connecting to every pin."""

    FIXTURE = os.path.join(
        os.path.dirname(__file__), "ic-migration-test-project.json"
    )

    def _load(self):
        with open(self.FIXTURE) as f:
            return json.load(f)

    def _pin_remap(self, project):
        """Build (round(old_abs)) -> new_abs from every affected IC component."""
        remap = {}
        for comp in project.get("components", []):
            family = _symbol_family(comp.get("defId", ""))
            offsets = _pin_offsets_for_def(comp.get("defId", ""))
            if family is None or not offsets:
                continue
            cx = comp["schematicPos"]["x"]
            cy = comp["schematicPos"]["y"]
            rotation = comp.get("schematicRotation", 0)
            mirrored = bool(comp.get("schematicMirrored"))
            old_mag = _X_OLD[family]
            new_mag = _X_NEW[family]
            for x_sign, y in offsets:
                ox, oy = _apply_transform(x_sign * old_mag, y, rotation, mirrored)
                nx, ny = _apply_transform(x_sign * new_mag, y, rotation, mirrored)
                remap[(round(cx + ox), round(cy + oy))] = (cx + nx, cy + ny)
        return remap

    def test_real_project_wires_relocate_correctly(self):
        data = self._load()

        # Build expected post-migration wire layout up front: each endpoint
        # either matches an old IC pin (and gets the new position) or stays put.
        pin_remap = self._pin_remap(data)
        expected = []
        for wire in data["schematicWires"]:
            row = {"id": wire["id"]}
            for endpoint in ("start", "end"):
                p = wire[endpoint]
                key = (round(p["x"]), round(p["y"]))
                row[endpoint] = pin_remap.get(key, (p["x"], p["y"]))
            expected.append(row)

        # Sanity: the fixture wires many pins across every rotation/mirror.
        moved = sum(
            1 for w, e in zip(data["schematicWires"], expected)
            if (w["start"]["x"], w["start"]["y"]) != e["start"]
            or (w["end"]["x"], w["end"]["y"]) != e["end"]
        )
        self.assertGreater(moved, 50, "fixture should have many IC-connected wires")

        out, changed = migrate_ic_unification(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], SCHEMA_VERSION)
        self.assertEqual(len(out["schematicWires"]), len(expected))

        for w, exp in zip(out["schematicWires"], expected):
            self.assertEqual(
                (w["start"]["x"], w["start"]["y"]), exp["start"],
                f"wire {w['id']}.start: expected {exp['start']}, "
                f"got ({w['start']['x']}, {w['start']['y']})",
            )
            self.assertEqual(
                (w["end"]["x"], w["end"]["y"]), exp["end"],
                f"wire {w['id']}.end: expected {exp['end']}, "
                f"got ({w['end']['x']}, {w['end']['y']})",
            )

    def test_real_project_no_wire_left_at_old_ic_pin(self):
        """Post-migration invariant: no wire endpoint should still sit at one of
        the (now-stale) old IC pin positions. Catches partial-migration bugs."""
        data = self._load()
        old_positions = set(self._pin_remap(data).keys())

        out, _ = migrate_ic_unification(data)

        for w in out["schematicWires"]:
            for endpoint in ("start", "end"):
                p = w[endpoint]
                self.assertNotIn(
                    (round(p["x"]), round(p["y"])),
                    old_positions,
                    f"wire {w['id']}.{endpoint} still at old IC pin position "
                    f"({p['x']}, {p['y']}) after migration",
                )

    def test_real_project_idempotent(self):
        """Running the migration twice should be a no-op the second time."""
        data = self._load()
        migrate_ic_unification(data)
        snapshot = json.dumps(data, sort_keys=True)

        _, changed = migrate_ic_unification(data)
        self.assertFalse(changed)
        self.assertEqual(json.dumps(data, sort_keys=True), snapshot)


class ProjectMigrateEndpointTests(TestCase):
    """The POST /api/projects/migrate/ endpoint: stateless, no DB I/O.
    Used by the frontend when importing a JSON file on an older schema."""

    def test_returns_migrated_data(self):
        payload = {
            "components": [{
                "id": "c1", "defId": "def-ic-dip8",
                "schematicPos": {"x": 200, "y": 200},
                "schematicRotation": 0, "label": "U1",
                "boardPos": None, "rotation": 0,
            }],
            "schematicWires": [{
                "id": "w1",
                "start": {"x": 150, "y": 180},  # old DIP-8 pin1 abs
                "end": {"x": 500, "y": 180},
                "routeDirection": "horizontal-first",
            }],
        }
        res = Client().post(
            "/api/projects/migrate/",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(body["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_rejects_non_object(self):
        res = Client().post(
            "/api/projects/migrate/",
            data=json.dumps([1, 2, 3]),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)

    def test_already_current_data_passes_through_unchanged(self):
        payload = {"version": CURRENT_SCHEMA_VERSION, "components": [], "schematicWires": [], "netLabels": [], "wiring": "touch"}
        res = Client().post(
            "/api/projects/migrate/",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), payload)


class SaveHookRouteTests(TestCase):
    """PUT /api/projects/<edit_uuid>/ must run the migration through the
    serializer and persist v2 data to the DB."""

    def setUp(self):
        # Seed directly via the ORM so we can put v1-shaped data in the DB
        # without going through any endpoint.
        self.project = Project.create_with_main(name="Test", data=_v1_dip8_payload())

    def test_put_v1_payload_migrates_and_persists(self):
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": _v1_dip8_payload()}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("data", res.json(), "a save answers with the history, not the design")
        # The stored design is migrated...
        body = Client().get(f"/api/projects/{self.project.edit_uuid}/").json()
        self.assertEqual(body["data"]["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(body["data"]["schematicWires"][0]["start"], {"x": 140, "y": 180})
        # ...and the DB row matches.
        self.project.refresh_from_db()
        self.assertEqual(_main(self.project)["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(_main(self.project)["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_put_current_payload_unchanged(self):
        payload = {"version": CURRENT_SCHEMA_VERSION, "components": [], "schematicWires": [], "netLabels": [], "wiring": "touch"}
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": payload}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(_main(self.project), payload)

    def test_put_full_fixture_round_trip(self):
        """End-to-end with the comprehensive fixture: PUT v1 data, get v2 back,
        verify a sample of pin endpoints moved correctly."""
        with open(FIXTURE_PATH) as f:
            fixture = json.load(f)
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Fixture", "data": fixture}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(_main(self.project)["version"], CURRENT_SCHEMA_VERSION)
        # No wire should still sit at one of the OLD IC pin positions.
        # (Reuses the same invariant as IcUnificationRealWorldTests.)
        old_positions = set()
        for comp in fixture["components"]:
            family = _symbol_family(comp.get("defId", ""))
            offsets = _pin_offsets_for_def(comp.get("defId", ""))
            if family is None or not offsets:
                continue
            cx, cy = comp["schematicPos"]["x"], comp["schematicPos"]["y"]
            rotation = comp.get("schematicRotation", 0)
            mirrored = bool(comp.get("schematicMirrored"))
            for x_sign, y in offsets:
                ox, oy = _apply_transform(x_sign * _X_OLD[family], y, rotation, mirrored)
                old_positions.add((round(cx + ox), round(cy + oy)))
        # v3 turns every L's bend into an endpoint; a corner in empty space may
        # coincide with an old pin position, which is not a wire left behind.
        v2, _ = migrate_ic_unification(json.loads(json.dumps(fixture)))
        bends = set()
        for w in v2["schematicWires"]:
            a, b = w["start"], w["end"]
            if a["x"] != b["x"] and a["y"] != b["y"]:
                bends.add((a["x"], b["y"]) if w.get("routeDirection") == "vertical-first" else (b["x"], a["y"]))
        for w in _main(self.project)["schematicWires"]:
            self.assertTrue(w["start"]["x"] == w["end"]["x"] or w["start"]["y"] == w["end"]["y"], "stored wires are straight")
            for endpoint in ("start", "end"):
                p = (round(w[endpoint]["x"]), round(w[endpoint]["y"]))
                if p in bends:
                    continue
                self.assertNotIn(p, old_positions)

    def test_put_oversize_payload_rejected(self):
        """The size cap that validate_data enforces — payload larger than 1MB
        must 400, regardless of version."""
        oversize = {"version": 2, "components": [], "schematicWires": [],
                    "padding": "x" * 1_100_000}
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": oversize}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)


class CreateHookRouteTests(TestCase):
    """POST /api/projects/ must run the migration through the serializer.
    Authenticated to skip the PoW gate."""

    def setUp(self):
        self.user = User.objects.create_user("testuser", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)

    def test_post_v1_payload_creates_as_v2(self):
        res = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "New", "data": _v1_dip8_payload()}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 201)
        project = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertEqual(_main(project)["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(_main(project)["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_post_current_payload_unchanged(self):
        payload = {"version": CURRENT_SCHEMA_VERSION, "components": [], "schematicWires": [], "netLabels": [], "wiring": "touch"}
        res = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "New", "data": payload}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 201)
        project = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertEqual(_main(project), payload)


class SchematicV3Tests(TestCase):
    """v2 -> v3: L-shaped wires become two straight wires meeting at the old
    bend, netLabels appears, version is stamped. Lossless and idempotent."""

    def test_l_wire_splits_at_bend_horizontal_first(self):
        data = {"version": 2, "components": [], "schematicWires": [{
            "id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 60},
            "routeDirection": "horizontal-first",
        }]}
        out, changed = migrate_schematic_v3(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], V3)
        ws = out["schematicWires"]
        self.assertEqual(len(ws), 2)
        self.assertEqual((ws[0]["start"], ws[0]["end"]), ({"x": 0, "y": 0}, {"x": 100, "y": 0}))
        self.assertEqual((ws[1]["start"], ws[1]["end"]), ({"x": 100, "y": 0}, {"x": 100, "y": 60}))
        self.assertEqual(ws[0]["id"], "w1")
        self.assertNotEqual(ws[1]["id"], "w1")
        for w in ws:
            self.assertNotIn("routeDirection", w)

    def test_l_wire_splits_at_bend_vertical_first(self):
        data = {"version": 2, "schematicWires": [{
            "id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 60},
            "routeDirection": "vertical-first",
        }]}
        out, _ = migrate_schematic_v3(data)
        ws = out["schematicWires"]
        self.assertEqual(ws[0]["end"], {"x": 0, "y": 60})
        self.assertEqual(ws[1]["start"], {"x": 0, "y": 60})

    def test_missing_route_direction_defaults_horizontal_first(self):
        data = {"version": 2, "schematicWires": [{
            "id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 60},
        }]}
        out, _ = migrate_schematic_v3(data)
        self.assertEqual(out["schematicWires"][0]["end"], {"x": 100, "y": 0})

    def test_straight_wire_kept_without_route_direction(self):
        data = {"version": 2, "schematicWires": [_wire(0, 0, 100, 0, "w1")]}
        out, _ = migrate_schematic_v3(data)
        ws = out["schematicWires"]
        self.assertEqual(len(ws), 1)
        self.assertEqual(ws[0], {"id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 0}})

    def test_zero_length_and_malformed_wires_dropped(self):
        data = {"version": 2, "schematicWires": [
            _wire(5, 5, 5, 5, "z"),
            {"id": "bad", "start": {"x": 1}},
            "not a wire",
            _wire(0, 0, 0, 40, "ok"),
        ]}
        out, _ = migrate_schematic_v3(data)
        self.assertEqual([w["id"] for w in out["schematicWires"]], ["ok"])

    def test_net_labels_added_and_kept(self):
        out, _ = migrate_schematic_v3({"version": 2, "schematicWires": []})
        self.assertEqual(out["netLabels"], [])
        self.assertEqual(out["wiring"], "touch", "nothing to join: behaves like a new project")
        out, _ = migrate_schematic_v3({"version": 2, "schematicWires": [], "wiring": "classic"})
        self.assertEqual(out["wiring"], "classic", "an explicit choice is kept")

    def test_wiring_decision(self):
        # Two resistors (pins at y ±20 of the origin), wired end to end: nothing
        # touches without being connected -> touch
        def resistor(cid, x, y):
            return {"id": cid, "defId": "def-resistor", "label": cid, "schematicPos": {"x": x, "y": y},
                    "schematicRotation": 0, "boardPos": None, "rotation": 0}
        clean = {"version": 2, "components": [resistor("A", 0, 100), resistor("B", 200, 100)],
                 "schematicWires": [_wire(0, 120, 200, 120)]}
        self.assertEqual(decide_wiring(clean), "touch")
        # A pin of another net sits on that wire's body (P.1 and R.2 meet at
        # (100,120), which lies on A-B): touch rules would join two nets -> classic
        crossing = {"version": 2, "components": [resistor("A", 0, 100), resistor("B", 200, 100),
                                                 resistor("P", 100, 140), resistor("R", 100, 100)],
                    "schematicWires": [_wire(0, 120, 200, 120)]}
        self.assertEqual(decide_wiring(crossing), "classic")
        # A wire end resting on another net's wire body -> classic
        tee = {"version": 2, "components": [resistor("A", 0, 100), resistor("B", 200, 100), resistor("C", 100, 300)],
               "schematicWires": [_wire(0, 120, 200, 120), _wire(100, 280, 100, 120), _wire(100, 280, 100, 320)]}
        self.assertEqual(decide_wiring(tee), "classic")
        # A lone pin under a wire would join that net: the net grows, so classic
        grows = {"version": 2, "components": [resistor("A", 0, 100), resistor("B", 200, 100), resistor("P", 100, 140)],
                 "schematicWires": [_wire(0, 120, 200, 120)]}
        self.assertEqual(decide_wiring(grows), "classic")
        # A flag on a wire's body, sharing its name with a flag on another
        # net: under touch the two nets merge -> classic
        flagged = {"version": 2, "components": [resistor("A", 0, 100), resistor("B", 200, 100),
                                                resistor("C", 0, 300), resistor("D", 200, 300)],
                   "schematicWires": [_wire(0, 120, 200, 120), _wire(0, 320, 200, 320)],
                   "netLabels": [
                       {"id": "l1", "kind": "gnd", "name": "GND", "pos": {"x": 100, "y": 120}, "rotation": 0},
                       {"id": "l2", "kind": "gnd", "name": "GND", "pos": {"x": 0, "y": 320}, "rotation": 0},
                   ]}
        self.assertEqual(decide_wiring(flagged), "classic")
        # The same flags, both at wire ends: they connect under either rule
        # set, so the drawing already behaves like touch
        ends = dict(flagged, netLabels=[
            {"id": "l1", "kind": "gnd", "name": "GND", "pos": {"x": 0, "y": 120}, "rotation": 0},
            {"id": "l2", "kind": "gnd", "name": "GND", "pos": {"x": 0, "y": 320}, "rotation": 0},
        ])
        self.assertEqual(decide_wiring(ends), "touch")
        # An unknown part: cannot tell -> classic to be safe
        unknown = {"version": 2, "components": [{"id": "X", "defId": "def-nope", "schematicPos": {"x": 0, "y": 0}}],
                   "schematicWires": [_wire(0, 0, 40, 0)]}
        self.assertEqual(decide_wiring(unknown), "classic")
        # An L-shaped v2 wire is split first, so a pin on its bend is a real
        # junction, not a body contact
        out, _ = migrate_schematic_v3({"version": 2, "components": [resistor("A", 0, 100), resistor("B", 220, 40)],
                                       "schematicWires": [{"id": "w", "start": {"x": 0, "y": 120}, "end": {"x": 220, "y": 60},
                                                           "routeDirection": "horizontal-first"}]})
        self.assertEqual(out["wiring"], "touch")

    def test_absurd_drawing_is_not_decided(self):
        """The decision is quadratic and runs on posted data, so a drawing far
        past any real one is answered with the safe rule set instead."""
        import time
        wires = [{"id": str(i), "start": {"x": 0, "y": i * 20}, "end": {"x": 99999, "y": i * 20}}
                 for i in range(13000)]
        started = time.time()
        self.assertEqual(decide_wiring({"version": 2, "schematicWires": wires, "components": []}), "classic")
        self.assertLess(time.time() - started, 1.0, "the guard did not keep the work bounded")

    def test_symbol_pins_cover_every_default_part(self):
        """The generated table resolves every built-in part, and the
        parametric generators agree with it where both exist."""
        from projects.migrations_data.schematic_v3 import DEFAULT_DEF_SYMBOL, _symbol_pins, STATIC_SYMBOL_PINS
        for def_id, symbol in DEFAULT_DEF_SYMBOL.items():
            self.assertIsNotNone(_symbol_pins(symbol), f"{def_id} ({symbol}) has no pins")
        for symbol, pins in STATIC_SYMBOL_PINS.items():
            if symbol.startswith(("generic-ic-", "connector-", "box-")):
                generated = _symbol_pins(symbol)
                table = [(str(p[0]), p[1], p[2]) for p in pins]
                self.assertEqual(sorted(generated), sorted(table), f"generator disagrees with the table for {symbol}")
        labels = [{"id": "l", "kind": "gnd", "name": "GND", "pos": {"x": 0, "y": 0}, "rotation": 0}]
        out, _ = migrate_schematic_v3({"version": 2, "schematicWires": [], "netLabels": labels})
        self.assertEqual(out["netLabels"], labels)

    def test_idempotent_on_v3(self):
        data = {"version": 3, "schematicWires": [_wire(0, 0, 100, 0)], "netLabels": [], "wiring": "classic"}
        before = json.loads(json.dumps(data))
        out, changed = migrate_schematic_v3(data)
        self.assertFalse(changed)
        self.assertEqual(out, before)

    def test_v3_row_without_wiring_gets_the_decision_only(self):
        """A row migrated by an earlier build has version 3 but no wiring
        field; it must not read as classic forever."""
        wires = [{"id": "w", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 0}}]
        data = {"version": 3, "components": [], "schematicWires": wires, "netLabels": []}
        out, changed = migrate_schematic_v3(data)
        self.assertTrue(changed)
        self.assertEqual(out["wiring"], "touch")
        self.assertEqual(out["schematicWires"], wires, "nothing else is touched")
        out, changed = migrate_schematic_v3(out)
        self.assertFalse(changed, "and it is idempotent afterwards")

    def test_non_dict_and_missing_keys(self):
        out, changed = migrate_schematic_v3("nope")
        self.assertEqual(out, "nope")
        self.assertFalse(changed)
        out, changed = migrate_schematic_v3({"version": 2})
        self.assertTrue(changed)
        self.assertEqual(out["schematicWires"], [])
        self.assertEqual(out["netLabels"], [])

    def test_pipeline_runs_v1_to_v3_in_one_pass(self):
        data = _v1_dip8_payload()
        out, changed = migrate_to_current(data)
        self.assertTrue(changed)
        self.assertEqual(out["version"], CURRENT_SCHEMA_VERSION)
        # ic_unification re-pointed pin 1 first, then v3 kept the straight wire
        self.assertEqual(out["schematicWires"][0]["start"], {"x": 140, "y": 180})
        self.assertNotIn("routeDirection", out["schematicWires"][0])

    def test_real_fixture_connectivity_preserved(self):
        """Every old bend contact (a pin or a wire end sitting on an L's bend)
        must survive as a vertex contact after the split."""
        with open(FIXTURE_PATH) as f:
            data = json.load(f)
        data, _ = migrate_ic_unification(data)
        old_wires = json.loads(json.dumps(data["schematicWires"]))

        def bend(w):
            a, b = w["start"], w["end"]
            if a["x"] == b["x"] or a["y"] == b["y"]:
                return None
            return (a["x"], b["y"]) if w.get("routeDirection") == "vertical-first" else (b["x"], a["y"])

        old_points = set()
        for w in old_wires:
            old_points.add((w["start"]["x"], w["start"]["y"]))
            old_points.add((w["end"]["x"], w["end"]["y"]))
            bp = bend(w)
            if bp:
                old_points.add(bp)

        out, _ = migrate_schematic_v3(data)
        new_points = set()
        for w in out["schematicWires"]:
            new_points.add((w["start"]["x"], w["start"]["y"]))
            new_points.add((w["end"]["x"], w["end"]["y"]))
            self.assertTrue(w["start"]["x"] == w["end"]["x"] or w["start"]["y"] == w["end"]["y"], "all wires straight")
        self.assertEqual(old_points, new_points, "the set of connection points is unchanged")
        self.assertGreater(len(out["schematicWires"]), len(old_wires))


class ProjectMigrateEndpointV3Tests(TestCase):
    def test_endpoint_returns_current_schema(self):
        payload = {"version": 2, "components": [], "schematicWires": [{
            "id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 60},
            "routeDirection": "horizontal-first",
        }]}
        res = Client().post("/api/projects/migrate/", data=json.dumps(payload), content_type="application/json")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(len(body["schematicWires"]), 2)

    def test_fork_of_v2_row_is_v3(self):
        original = Project.create_with_main(name="old", data={
            "version": 2, "components": [], "nets": [], "netAssignments": [],
            "schematicWires": [{"id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 60}, "routeDirection": "vertical-first"}],
            "board": {"rows": 10, "cols": 10, "cuts": [], "wires": []},
        })
        res = Client().post(f"/api/projects/fork/{original.view_uuid}/")
        self.assertEqual(res.status_code, 201)
        forked = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertEqual(_main(forked)["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(len(_main(forked)["schematicWires"]), 2)
        self.assertEqual(_main(original)["version"], 2, "the original row is left alone")


class ReadHookTests(TestCase):
    """GET responses migrate on the fly (nothing is written), so a row the
    one-shot command has not reached yet, or a view-only visitor, still gets
    current-schema data."""

    def setUp(self):
        self.project = Project.create_with_main(name="old", data={
            "version": 2, "components": [], "nets": [], "netAssignments": [],
            "schematicWires": [{"id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 60}, "routeDirection": "horizontal-first"}],
            "board": {"rows": 10, "cols": 10, "cuts": [], "wires": []},
        })

    def test_detail_get_is_current(self):
        res = Client().get(f"/api/projects/{self.project.edit_uuid}/")
        self.assertEqual(res.status_code, 200)
        data = res.json()["data"]
        self.assertEqual(data["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(len(data["schematicWires"]), 2)
        self.project.refresh_from_db()
        self.assertEqual(_main(self.project)["version"], 2, "reading never writes")

    def test_view_get_is_current(self):
        res = Client().get(f"/api/projects/view/{self.project.view_uuid}/")
        self.assertEqual(res.status_code, 200)
        data = res.json()["data"]
        self.assertEqual(data["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(len(data["schematicWires"]), 2)


def _opto_v3(wires, *, rotation=0, wiring="classic", labels=None):
    return {
        "version": 3, "wiring": wiring, "netLabels": labels or [],
        "components": [_comp("u1", "def-optocoupler", 360, 300, rotation=rotation)],
        "schematicWires": wires,
    }


def _ends(data):
    return sorted(tuple(sorted(((w["start"]["x"], w["start"]["y"]), (w["end"]["x"], w["end"]["y"]))))
                  for w in data["schematicWires"])


class OptocouplerV4Tests(TestCase):
    """The optocoupler became a generic 4-pin IC: pins 1 and 4 move from
    y = -20 to y = 0 in its own frame, and whatever met them follows."""

    def test_wire_on_pin_1_is_carried_to_the_new_pin(self):
        out, changed = migrate_optocoupler_v4(_opto_v3([_wire(200, 280, 300, 280)]))
        self.assertTrue(changed)
        self.assertEqual(out["version"], 4)
        self.assertEqual(_ends(out), [((200, 280), (300, 280)), ((300, 280), (300, 300))])
        self.assertEqual(out["components"][0]["schematicPos"], {"x": 360, "y": 300}, "the part stays put")

    def test_pins_that_nothing_meets_get_no_wire(self):
        # only pin 2 (unmoved) is wired
        out, _ = migrate_optocoupler_v4(_opto_v3([_wire(200, 320, 300, 320)]))
        self.assertEqual(len(out["schematicWires"]), 1)

    def test_a_flag_on_the_old_spot_is_carried_too(self):
        flag = [{"id": "l", "kind": "gnd", "name": "GND", "pos": {"x": 420, "y": 280}, "rotation": 0}]
        out, _ = migrate_optocoupler_v4(_opto_v3([], labels=flag))
        self.assertEqual(_ends(out), [((420, 280), (420, 300))])

    def test_rotated_part(self):
        # at 180 degrees pin 1 sits at (+60, +20) from the origin and moves to (+60, 0)
        out, _ = migrate_optocoupler_v4(_opto_v3([_wire(420, 320, 500, 320)], rotation=180))
        self.assertIn(((420, 300), (420, 320)), _ends(out))

    def test_taken_spot_moves_the_part_instead(self):
        """A wire of pin 2's net already passes the spot pin 1 would move to,
        so the part moves up a step and pins 2 and 3 follow it."""
        wires = [_wire(200, 280, 300, 280, "a"), _wire(200, 300, 300, 300, "k"), _wire(300, 300, 300, 320, "k2")]
        out, _ = migrate_optocoupler_v4(_opto_v3(wires, wiring="touch"))
        self.assertEqual(out["components"][0]["schematicPos"], {"x": 360, "y": 280})
        self.assertEqual(len(out["schematicWires"]), 3, "the wire to pin 2's new spot is already there")

    def test_idempotent_and_in_the_pipeline(self):
        out, _ = migrate_to_current(_opto_v3([_wire(200, 280, 300, 280)]))
        self.assertEqual(out["version"], CURRENT_SCHEMA_VERSION)
        before = json.loads(json.dumps(out))
        again, changed = migrate_to_current(out)
        self.assertFalse(changed)
        self.assertEqual(again, before)

    def test_v3_decision_still_uses_the_old_pins(self):
        from projects.migrations_data.schematic_v3 import DEFAULT_DEF_SYMBOL, _symbol_pins
        self.assertEqual(DEFAULT_DEF_SYMBOL["def-optocoupler"], "optocoupler")
        self.assertIn(("1", -60, -20), _symbol_pins("optocoupler"))


def _grid_part(name="Relay", width=2, pins=None):
    return {
        "id": "custom-x", "name": name, "category": "generic", "symbol": "custom-footprint-custom-x",
        "defaultLabelPrefix": "K", "width": width, "height": 2,
        "pins": pins or [{"id": "1", "name": "1", "offsetRow": 0, "offsetCol": 0}],
    }


class UserPartLibraryTests(TestCase):
    """The per-user part library: storage, limits, ownership, and carrying an
    edit into the projects that hold a linked copy."""

    def setUp(self):
        self.user = User.objects.create_user("owner", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)

    def _post(self, part):
        return self.client.post("/api/users/me/parts/", data=json.dumps({"part": part}), content_type="application/json")

    def _project_with_copy(self, part_id, rev=1, placed=True, name="P"):
        copy = {**_grid_part(), "id": "custom-copy", "symbol": "custom-footprint-custom-copy",
                "library": {"id": part_id, "rev": rev}}
        comp = {"id": "k1", "defId": "custom-copy", "boardPos": {"row": 1, "col": 1} if placed else None,
                "footprintOverride": {"width": 2, "height": 2, "pins": []}, "package": "to220"}
        data = {"version": CURRENT_SCHEMA_VERSION, "componentDefs": [copy], "components": [comp]}
        return Project.create_with_main(owner=self.user, name=name, data=data)

    def test_create_list_delete(self):
        res = self._post(_grid_part())
        self.assertEqual(res.status_code, 201)
        part_id = res.json()["id"]
        listed = self.client.get("/api/users/me/parts/").json()
        self.assertEqual([p["id"] for p in listed], [part_id])
        self.assertEqual(self.client.delete(f"/api/users/me/parts/{part_id}/").status_code, 204)
        self.assertEqual(self.client.get("/api/users/me/parts/").json(), [])

    def test_requires_login(self):
        self.assertIn(Client().get("/api/users/me/parts/").status_code, (401, 403))

    def test_rejects_malformed_and_oversize_parts(self):
        self.assertEqual(self._post({"name": "x"}).status_code, 400)
        huge = _grid_part(pins=[{"id": str(i), "name": "N" * 40, "offsetRow": 0, "offsetCol": i} for i in range(1500)])
        res = self._post(huge)
        self.assertEqual(res.status_code, 400)
        self.assertIn("too large", res.json()["error"])

    def test_rejects_parts_the_editor_cannot_show(self):
        # An imported file can carry anything; what gets in must render and open in the editor
        bad = [
            {**_grid_part(), "symbol": None},
            {**_grid_part(), "symbol": "sip-ic-100000000"},
            {**_grid_part(), "width": 10000},
            {**_grid_part(), "defaultLabelPrefix": 7},
            {**_grid_part(), "group": ["Passive"]},
            _grid_part(pins=[{"id": "1", "name": "1", "offsetRow": 5, "offsetCol": 0}]),
            _grid_part(pins=[{"id": 1, "name": "1", "offsetRow": 0, "offsetCol": 0}]),
            _grid_part(pins=["1"]),
            {**_grid_part(), "bodyCells": [{"row": "a"}]},
            {**_grid_part(), "spec": {"footprint": "dip"}},
            {**_grid_part(), "spec": {"footprint": {"kind": "dip"}, "pins": "12345678"}},
        ]
        for part in bad:
            self.assertEqual(self._post(part).status_code, 400, part)
        good = {**_grid_part(), "symbol": "generic-ic-8", "group": "Passive", "description": "",
                "bodyCells": [{"row": 1, "col": 1}], "spec": {"footprint": {"kind": "dip", "pins": 8}, "pins": ["1"] * 8}}
        self.assertEqual(self._post(good).status_code, 201)

    def test_library_limit(self):
        from projects.user_parts import MAX_PARTS_PER_USER
        UserPart.objects.bulk_create([UserPart(owner=self.user, part=_grid_part()) for _ in range(MAX_PARTS_PER_USER)])
        self.assertEqual(self._post(_grid_part()).status_code, 403)

    def test_other_users_parts_are_invisible(self):
        other = User.objects.create_user("other", password="x" * 64)
        theirs = UserPart.objects.create(owner=other, part=_grid_part())
        self.assertEqual(self.client.get("/api/users/me/parts/").json(), [])
        res = self.client.put(f"/api/users/me/parts/{theirs.id}/", data=json.dumps({"part": _grid_part()}),
                              content_type="application/json")
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.client.delete(f"/api/users/me/parts/{theirs.id}/").status_code, 404)

    def test_update_carries_into_linked_projects(self):
        part = UserPart.objects.create(owner=self.user, part=_grid_part())
        linked = self._project_with_copy(str(part.id))
        skipped = self._project_with_copy(str(part.id), name="Open in the editor")
        unlinked = Project.create_with_main(owner=self.user, data={"componentDefs": [{**_grid_part(), "id": "custom-copy"}], "components": []})
        usage = self.client.get(f"/api/users/me/parts/{part.id}/usage/").json()
        self.assertEqual(sorted(u["name"] for u in usage), ["Open in the editor", "P"])
        self.assertEqual(usage[0]["placed"], 1)

        wider = _grid_part(name="Relay 2", width=3)
        res = self.client.put(f"/api/users/me/parts/{part.id}/", content_type="application/json",
                              data=json.dumps({"part": wider, "update_projects": True, "skip_project": str(skipped.edit_uuid)}))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["rev"], 2)
        self.assertEqual(res.json()["updated_projects"], 1)

        linked.refresh_from_db()
        copy = _main(linked)["componentDefs"][0]
        self.assertEqual((copy["id"], copy["name"], copy["width"]), ("custom-copy", "Relay 2", 3))
        self.assertEqual(copy["symbol"], "custom-footprint-custom-copy", "the symbol follows the project's own id")
        self.assertEqual(copy["library"], {"id": str(part.id), "rev": 2})
        comp = _main(linked)["components"][0]
        self.assertIsNone(comp["boardPos"], "a changed footprint sends the placed part back to unplaced")
        self.assertNotIn("footprintOverride", comp)
        self.assertNotIn("package", comp, "the package was chosen for the old footprint")

        skipped.refresh_from_db()
        self.assertEqual(_main(skipped)["componentDefs"][0]["name"], "Relay")
        unlinked.refresh_from_db()
        self.assertEqual(_main(unlinked)["componentDefs"][0]["name"], "Relay")

    def test_update_drops_net_assignments_of_removed_pins(self):
        part = UserPart.objects.create(owner=self.user, part=_grid_part())
        linked = self._project_with_copy(str(part.id))
        main = linked.main_branch
        main.data["components"].append({"id": "r1", "defId": "def-resistor", "boardPos": None})
        main.data["netAssignments"] = [
            {"netId": "n1", "componentId": "k1", "pinId": "1"},
            {"netId": "n2", "componentId": "k1", "pinId": "2"},
            {"netId": "n2", "componentId": "r1", "pinId": "2"},
        ]
        main.save()
        pin_two = _grid_part(pins=[{"id": "2", "name": "2", "offsetRow": 0, "offsetCol": 0}])
        self.client.put(f"/api/users/me/parts/{part.id}/", content_type="application/json",
                        data=json.dumps({"part": pin_two, "update_projects": True}))
        linked.refresh_from_db()
        self.assertEqual(
            [(a["componentId"], a["pinId"]) for a in _main(linked)["netAssignments"]],
            [("k1", "2"), ("r1", "2")],
            "pin 1 is gone from the part; other parts' pins are left alone",
        )

    def test_same_footprint_keeps_parts_placed(self):
        part = UserPart.objects.create(owner=self.user, part=_grid_part())
        linked = self._project_with_copy(str(part.id))
        renamed = _grid_part(name="Relay, 5 V", pins=[{"id": "1", "name": "COIL", "offsetRow": 0, "offsetCol": 0}])
        self.client.put(f"/api/users/me/parts/{part.id}/", content_type="application/json",
                        data=json.dumps({"part": renamed, "update_projects": True}))
        linked.refresh_from_db()
        self.assertEqual(_main(linked)["components"][0]["boardPos"], {"row": 1, "col": 1})

    def test_update_without_projects_touches_none(self):
        part = UserPart.objects.create(owner=self.user, part=_grid_part())
        linked = self._project_with_copy(str(part.id))
        self.client.put(f"/api/users/me/parts/{part.id}/", content_type="application/json",
                        data=json.dumps({"part": _grid_part(name="Changed")}))
        linked.refresh_from_db()
        self.assertEqual(_main(linked)["componentDefs"][0]["name"], "Relay")


class UserPartFoundAndImportTests(TestCase):
    """Parts found in the user's projects can be adopted into the library,
    which links the copies they came from; exported files can be imported."""

    def setUp(self):
        self.user = User.objects.create_user("owner", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)

    def _project(self, name, defs):
        return Project.create_with_main(owner=self.user, name=name, data={"componentDefs": defs, "components": []})

    def test_identical_parts_are_found_once_and_adopted_together(self):
        a = self._project("A", [{**_grid_part(), "id": "custom-a", "symbol": "custom-footprint-custom-a"}])
        b = self._project("B", [{**_grid_part(), "id": "custom-b", "symbol": "custom-footprint-custom-b"}])
        other = self._project("C", [{**_grid_part(name="Buzzer"), "id": "custom-c", "symbol": "custom-footprint-custom-c"}])
        found = self.client.get("/api/users/me/parts/found/").json()
        self.assertEqual(sorted((g["part"]["name"], len(g["projects"])) for g in found), [("Buzzer", 1), ("Relay", 2)])

        relay = next(g for g in found if g["part"]["name"] == "Relay")
        res = self.client.post("/api/users/me/parts/adopt/", data=json.dumps({"key": relay["key"]}), content_type="application/json")
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["linked_projects"], 2)
        part_id = res.json()["id"]
        for project in (a, b):
            project.refresh_from_db()
            self.assertEqual(_main(project)["componentDefs"][0]["library"], {"id": part_id, "rev": 1})
        other.refresh_from_db()
        self.assertNotIn("library", _main(other)["componentDefs"][0])

        remaining = self.client.get("/api/users/me/parts/found/").json()
        self.assertEqual([g["part"]["name"] for g in remaining], ["Buzzer"], "adopted parts are no longer listed")
        listed = self.client.get("/api/users/me/parts/?usage=1").json()
        self.assertEqual(listed[0]["used_in"], 2)

    def test_adopting_an_unknown_key_fails(self):
        res = self.client.post("/api/users/me/parts/adopt/", data=json.dumps({"key": "nope"}), content_type="application/json")
        self.assertEqual(res.status_code, 404)

    def test_other_users_projects_are_not_searched(self):
        other = User.objects.create_user("other", password="x" * 64)
        Project.create_with_main(owner=other, data={"componentDefs": [_grid_part()]})
        self.assertEqual(self.client.get("/api/users/me/parts/found/").json(), [])

    def test_import_adds_every_part_or_none(self):
        good = [_grid_part(name="One"), {**_grid_part(name="Two"), "library": {"id": "someone-else", "rev": 9}}]
        res = self.client.post("/api/users/me/parts/import/", data=json.dumps({"parts": good}), content_type="application/json")
        self.assertEqual(res.status_code, 201)
        self.assertEqual([p["part"]["name"] for p in res.json()], ["One", "Two"])
        self.assertTrue(all("library" not in p.part for p in UserPart.objects.all()), "imported parts carry no links")
        bad = [_grid_part(name="Three"), {"name": "broken"}]
        res = self.client.post("/api/users/me/parts/import/", data=json.dumps({"parts": bad}), content_type="application/json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("Part 2", res.json()["error"])
        self.assertEqual(UserPart.objects.count(), 2)


class ProjectLimitTests(TestCase):
    def test_signed_in_users_are_capped(self):
        from projects import views
        user = User.objects.create_user("many", password="x" * 64)
        client = Client()
        client.force_login(user)
        Project.objects.bulk_create([Project(owner=user, data={}) for _ in range(views.MAX_PROJECTS_PER_USER)])
        payload = json.dumps({"name": "One more", "data": {"version": CURRENT_SCHEMA_VERSION}})
        res = client.post("/api/projects/", data=payload, content_type="application/json")
        self.assertEqual(res.status_code, 403)
        anon = Project.create_with_main(data={})
        self.assertEqual(client.post(f"/api/projects/{anon.edit_uuid}/claim/").status_code, 403)
        self.assertEqual(client.post(f"/api/projects/fork/{anon.view_uuid}/").status_code, 403)


class ProjectDuplicateRenameTests(TestCase):
    """Duplicate and rename from the project list: owner only."""

    def setUp(self):
        self.user = User.objects.create_user("owner", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)
        self.project = Project.create_with_main(
            owner=self.user, name="Fuzz", data={"version": CURRENT_SCHEMA_VERSION, "name": "Fuzz", "components": []},
        )

    def test_duplicate_copies_data_under_a_new_name(self):
        res = self.client.post(f"/api/projects/{self.project.edit_uuid}/duplicate/")
        self.assertEqual(res.status_code, 201)
        copy = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertNotEqual(copy.pk, self.project.pk)
        self.assertEqual(copy.owner, self.user)
        self.assertEqual(copy.name, "Fuzz (copy)")
        self.assertEqual(self.client.get(f"/api/projects/{copy.edit_uuid}/").json()["data"]["name"], "Fuzz (copy)")
        self.assertEqual(_main(copy)["components"], [])
        self.assertIsNone(copy.fork_of)

    def test_rename_updates_row_and_json(self):
        res = self.client.post(
            f"/api/projects/{self.project.edit_uuid}/rename/",
            data=json.dumps({"name": "  <b>Big</b> Muff "}), content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.name, "Big Muff")
        detail = self.client.get(f"/api/projects/{self.project.edit_uuid}/").json()
        self.assertEqual(detail["data"]["name"], "Big Muff", "every branch is served with the project's name")

    def test_only_the_owner(self):
        other = Client()
        other.force_login(User.objects.create_user("other", password="x" * 64))
        url = f"/api/projects/{self.project.edit_uuid}"
        self.assertEqual(other.post(f"{url}/duplicate/").status_code, 404)
        self.assertEqual(other.post(f"{url}/rename/", data=json.dumps({"name": "x"}), content_type="application/json").status_code, 404)
        self.assertIn(Client().post(f"{url}/duplicate/").status_code, (401, 403))
        self.project.refresh_from_db()
        self.assertEqual(self.project.name, "Fuzz")

    def test_duplicate_respects_project_limit(self):
        from projects import views
        Project.objects.bulk_create([Project(owner=self.user, data={}) for _ in range(views.MAX_PROJECTS_PER_USER)])
        self.assertEqual(self.client.post(f"/api/projects/{self.project.edit_uuid}/duplicate/").status_code, 403)

    def test_duplicate_with_a_chosen_name(self):
        res = self.client.post(
            f"/api/projects/{self.project.edit_uuid}/duplicate/",
            data=json.dumps({"name": "Fuzz 9V"}), content_type="application/json",
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["name"], "Fuzz 9V")
        self.assertEqual(Project.objects.get(edit_uuid=res.json()["edit_uuid"]).name, "Fuzz 9V")


class UserProjectsPaginationTests(TestCase):
    def setUp(self):
        from urllib.parse import quote
        self.quote = quote
        self.user = User.objects.create_user("pager", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)
        Project.objects.bulk_create([Project(owner=self.user, name=f"P{i}", data={}) for i in range(7)])
        # Same timestamp for all: the id tie-break alone has to keep pages apart
        Project.objects.filter(owner=self.user).update(updated_at=timezone.now())

    def _page(self, before=None, limit=3):
        url = f"/api/users/me/projects/?limit={limit}"
        if before:
            url += f"&before={self.quote(before)}"
        res = self.client.get(url)
        self.assertEqual(res.status_code, 200)
        return res.json()

    def test_pages_cover_every_project_once(self):
        seen, cursor = [], None
        while True:
            page = self._page(cursor)
            seen += [p["edit_uuid"] for p in page["results"]]
            cursor = page["next"]
            if cursor is None:
                break
        self.assertEqual(len(seen), 7)
        self.assertEqual(len(set(seen)), 7)

    def test_new_project_does_not_shift_later_pages(self):
        first = self._page()
        Project.create_with_main(owner=self.user, name="New", data={})
        second = self._page(first["next"])
        self.assertTrue({p["edit_uuid"] for p in first["results"]}.isdisjoint(p["edit_uuid"] for p in second["results"]))
        self.assertNotIn("New", [p["name"] for p in second["results"]])

    def test_bad_cursor(self):
        self.assertEqual(self.client.get("/api/users/me/projects/?before=nonsense").status_code, 400)


class CreateMainBranchesCommandTests(TestCase):
    def test_moves_data_into_main_and_keeps_list_order(self):
        from django.core.management import call_command
        legacy = Project.objects.create(name="Old", data={"version": CURRENT_SCHEMA_VERSION, "components": [1]})
        Project.objects.filter(pk=legacy.pk).update(updated_at=timezone.now() - timezone.timedelta(days=30))
        before = Project.objects.get(pk=legacy.pk).updated_at
        call_command("create_main_branches", stdout=open(os.devnull, "w"))
        legacy.refresh_from_db()
        self.assertIsNotNone(legacy.main_branch)
        self.assertEqual(legacy.active_branch_id, legacy.main_branch_id)
        self.assertEqual(legacy.main_branch.name, "main")
        self.assertEqual(legacy.main_branch.data["components"], [1])
        self.assertIsNone(legacy.data, "the project's own copy is cleared")
        self.assertEqual(legacy.updated_at, before, "the project keeps its place in the list")
        call_command("create_main_branches", stdout=open(os.devnull, "w"))
        self.assertEqual(legacy.branches.count(), 1, "running again changes nothing")


def _design(**extra):
    return {"version": CURRENT_SCHEMA_VERSION, "components": [], "nets": [], "netAssignments": [],
            "schematicWires": [], "board": {"rows": 10, "cols": 10, "cuts": [], "wires": []}, **extra}


class BranchTests(TestCase):
    """Branches of one project: what is saved where, and who can reach what."""

    def setUp(self):
        self.client = Client()
        self.project = Project.create_with_main(_design(notes="main"), name="Amp")
        self.url = f"/api/projects/{self.project.edit_uuid}"

    def _post(self, path, body):
        return self.client.post(f"{self.url}{path}", data=json.dumps(body), content_type="application/json")

    def _branch(self, name="rev B", source=None):
        res = self._post("/branches/", {"name": name, "from": str(source or self.project.main_branch_id)})
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()

    def _save(self, branch, **data):
        body = {"data": _design(**data)}
        if branch:
            body["branch"] = branch
        res = self.client.put(f"{self.url}/", data=json.dumps(body), content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_new_branch_copies_its_parent_and_becomes_active(self):
        created = self._branch()
        self.assertEqual(created["data"]["notes"], "main")
        self.assertEqual(created["active_branch"], created["branch"])
        branch = Branch.objects.get(id=created["branch"])
        self.assertEqual(branch.parent_id, self.project.main_branch_id)
        self.assertEqual(ungz_json(branch.base_gz)["notes"], "main")
        listed = {b["name"]: b for b in created["branches"]}
        self.assertEqual(listed["rev B"]["parent"], str(self.project.main_branch_id))
        self.assertTrue(listed["main"]["is_main"])

    def test_saves_go_to_their_branch_and_the_default_is_main(self):
        b = self._branch()["branch"]
        self._save(b, notes="on B")
        self.assertEqual(_main(self.project)["notes"], "main", "main is untouched")
        self.assertEqual(self.client.get(f"{self.url}/?branch={b}").json()["data"]["notes"], "on B")
        self.assertEqual(self.client.get(f"{self.url}/?branch=active").json()["branch"], b)
        # An editor from before branches names none: it reads and saves main
        self.assertEqual(self.client.get(f"{self.url}/").json()["data"]["notes"], "main")
        self._save(None, notes="old editor")
        self.assertEqual(_main(self.project)["notes"], "old editor")
        self.assertEqual(Branch.objects.get(id=b).data["notes"], "on B")

    def test_names_must_be_unique_and_main_is_fixed(self):
        b = self._branch()["branch"]
        self.assertEqual(self._post("/branches/", {"name": "REV b", "from": b}).status_code, 400)
        main = self.project.main_branch_id
        res = self.client.patch(f"{self.url}/branches/{main}/", data=json.dumps({"name": "x"}), content_type="application/json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.delete(f"{self.url}/branches/{main}/").status_code, 400)
        res = self.client.patch(f"{self.url}/branches/{b}/", data=json.dumps({"name": "rev C"}), content_type="application/json")
        self.assertEqual(res.status_code, 200)
        self.assertIn("rev C", [x["name"] for x in res.json()["branches"]])

    def test_delete_refuses_a_branch_others_start_from(self):
        b = self._branch()["branch"]
        c = self._branch("rev C", source=b)["branch"]
        self.assertEqual(self.client.delete(f"{self.url}/branches/{b}/").status_code, 400)
        self.assertEqual(self.client.delete(f"{self.url}/branches/{c}/").status_code, 204)
        self.project.refresh_from_db()
        self.assertEqual(self.project.active_branch_id, self.project.main_branch_id, "deleting the active branch falls back to main")
        self.assertEqual(self.client.delete(f"{self.url}/branches/{b}/").status_code, 204)

    def test_branches_of_other_projects_are_out_of_reach(self):
        other = Project.create_with_main(_design(), name="Other")
        theirs = str(other.main_branch_id)
        self.assertEqual(self.client.get(f"{self.url}/?branch={theirs}").status_code, 404)
        res = self.client.put(f"{self.url}/", data=json.dumps({"branch": theirs, "data": _design()}), content_type="application/json")
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self._post("/branches/", {"name": "x", "from": theirs}).status_code, 404)
        self.assertEqual(self.client.get(f"/api/projects/view/{self.project.view_uuid}/?branch={theirs}").status_code, 404)

    def test_view_link_shows_main_and_can_look_at_branches_without_edit_uuid(self):
        b = self._branch()["branch"]
        self._save(b, notes="on B")
        view = f"/api/projects/view/{self.project.view_uuid}/"
        res = self.client.get(view)
        self.assertEqual(res.json()["data"]["notes"], "main")
        self.assertEqual(len(res.json()["branches"]), 2)
        other = self.client.get(f"{view}?branch={b}")
        self.assertEqual(other.json()["data"]["notes"], "on B")
        self.assertEqual(self.client.get(f"{view}?branch=active").status_code, 404)
        for r in (res, other):
            self.assertNotIn(str(self.project.edit_uuid), r.content.decode())
            self.assertNotIn(self.project.edit_uuid.hex, r.content.decode())

    def test_merge_into_parent(self):
        b = self._branch()["branch"]
        self._save(b, notes="on B")
        main = str(self.project.main_branch_id)
        prep = self.client.get(f"{self.url}/branches/{main}/merge/?source={b}").json()
        self.assertEqual(prep["kind"], "into-parent")
        self.assertEqual(prep["base"]["notes"], "main")
        self.assertEqual(prep["source"]["data"]["notes"], "on B")
        b_version = prep["source"]["version"]
        body = {"source": b, "data": _design(notes="merged"),
                "source_version": prep["source"]["version"], "target_version": prep["target"]["version"]}
        res = self._post(f"/branches/{main}/merge/", body)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(_main(self.project)["notes"], "merged")
        self.assertEqual(res.json()["merges"][0]["source_name"], "rev B")
        branch = Branch.objects.get(id=b)
        self.assertEqual(ungz_json(branch.base_gz)["notes"], "on B", "the merged state is the next common state")
        self.assertEqual(branch.updated_at.isoformat(), b_version, "the source's version is unchanged")
        self.assertIsNotNone(branch.closed_at, "merging into the parent closes the branch")
        listed = next(x for x in res.json()["branches"] if x["id"] == b)
        self.assertIsNotNone(listed["closed_at"])
        self.assertEqual(res.json()["active_branch"], main, "the editor lands on main")
        # A closed branch takes no saves, branches, switches or merges
        self.assertEqual(self._post(f"/branches/{main}/merge/", body).status_code, 400)
        put = self.client.put(f"{self.url}/", data=json.dumps({"branch": b, "data": _design()}), content_type="application/json")
        self.assertEqual(put.status_code, 400)
        self.assertEqual(self._post("/branches/", {"name": "again", "from": b}).status_code, 400)
        self.assertEqual(self._post(f"/branches/{b}/activate/", {}).status_code, 400)
        self.assertEqual(self.client.get(f"{self.url}/?branch={b}").status_code, 200, "it can still be looked at")

    def test_merge_into_parent_waits_for_open_branches_started_from_it(self):
        b = self._branch()["branch"]
        c = self._branch("rev C", source=b)["branch"]
        main = str(self.project.main_branch_id)
        self.assertEqual(self.client.get(f"{self.url}/branches/{main}/merge/?source={b}").status_code, 400)
        prep = self.client.get(f"{self.url}/branches/{b}/merge/?source={c}").json()
        res = self._post(f"/branches/{b}/merge/", {"source": c, "data": _design(notes="from C"),
                                                    "source_version": prep["source"]["version"],
                                                    "target_version": prep["target"]["version"]})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.client.get(f"{self.url}/branches/{main}/merge/?source={b}").status_code, 200,
                         "once rev C is merged, rev B can be")

    def test_merge_from_parent(self):
        b = self._branch()["branch"]
        main = str(self.project.main_branch_id)
        self._save(None, notes="main moved on")
        prep = self.client.get(f"{self.url}/branches/{b}/merge/?source={main}").json()
        self.assertEqual(prep["kind"], "from-parent")
        self.assertEqual(prep["base"]["notes"], "main")
        res = self._post(f"/branches/{b}/merge/", {"source": main, "data": _design(notes="taken in"),
                                                    "source_version": prep["source"]["version"],
                                                    "target_version": prep["target"]["version"]})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(ungz_json(Branch.objects.get(id=b).base_gz)["notes"], "main moved on")
        self.assertIsNone(Branch.objects.get(id=b).closed_at, "taking in the parent's changes keeps the branch open")

    def test_parent_changed_until_the_two_meet_again(self):
        b = self._branch()["branch"]
        flag = lambda: next(x for x in self.client.get(f"{self.url}/").json()["branches"] if x["id"] == b)["parent_changed"]
        self.assertFalse(flag())
        self._save(b, notes="on B")
        self.assertFalse(flag(), "the branch's own edits are not the parent's")
        self._save(None, notes="main moved on")
        self.assertTrue(flag())
        main = str(self.project.main_branch_id)
        prep = self.client.get(f"{self.url}/branches/{b}/merge/?source={main}").json()
        self._post(f"/branches/{b}/merge/", {"source": main, "data": _design(notes="taken in"),
                                              "source_version": prep["source"]["version"],
                                              "target_version": prep["target"]["version"]})
        self.assertFalse(flag())

    def test_only_a_branch_and_its_parent_merge(self):
        b = self._branch()["branch"]
        c = self._branch("rev C")["branch"]
        self.assertEqual(self.client.get(f"{self.url}/branches/{b}/merge/?source={c}").status_code, 400)
        self.assertEqual(self.client.get(f"{self.url}/branches/{b}/merge/?source=nonsense").status_code, 400)


class MergedBranchTests(TestCase):
    """Merged branches are history: they do not count toward the limit, block
    nothing, take no library updates, and go only with the branch they were
    merged into."""

    def setUp(self):
        self.user = User.objects.create_user("hist", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)
        self.project = Project.create_with_main(_design(), name="P", owner=self.user)
        self.url = f"/api/projects/{self.project.edit_uuid}"
        self.main = str(self.project.main_branch_id)

    def _post(self, path, body):
        return self.client.post(f"{self.url}{path}", data=json.dumps(body), content_type="application/json")

    def _branch(self, name, source=None):
        res = self._post("/branches/", {"name": name, "from": source or self.main})
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()["branch"]

    def _merge(self, target, source):
        prep = self.client.get(f"{self.url}/branches/{target}/merge/?source={source}").json()
        res = self._post(f"/branches/{target}/merge/", {"source": source, "data": prep["target"]["data"],
                                                         "source_version": prep["source"]["version"],
                                                         "target_version": prep["target"]["version"]})
        self.assertEqual(res.status_code, 200, res.content)

    def test_merged_branches_do_not_count_toward_the_limit(self):
        from projects.branches import MAX_BRANCHES_PER_PROJECT
        for i in range(MAX_BRANCHES_PER_PROJECT - 1):
            self._merge(self.main, self._branch(f"b{i}"))
        self.assertEqual(self.project.branches.count(), MAX_BRANCHES_PER_PROJECT)
        self._branch("one more")
        # Only open branches fill the project up
        Branch.objects.bulk_create([
            Branch(project=self.project, name=f"open {i}", data={}) for i in range(MAX_BRANCHES_PER_PROJECT - 2)
        ])
        self.assertEqual(self._post("/branches/", {"name": "too many", "from": self.main}).status_code, 403)

    def test_merged_branches_go_with_their_parent(self):
        b = self._branch("b")
        c = self._branch("c", source=b)
        self._merge(b, c)
        self.assertEqual(self.client.delete(f"{self.url}/branches/{c}/").status_code, 400, "not on its own")
        self.assertEqual(self.client.delete(f"{self.url}/branches/{b}/").status_code, 204, "a merged child does not block")
        self.assertFalse(Branch.objects.filter(id__in=[b, c]).exists(), "the merged child went with it")
        self.assertEqual(self.project.merges.count(), 1, "the merge row stays, pointing nowhere")

    def test_open_children_still_block(self):
        b = self._branch("b")
        self._branch("c", source=b)
        self.assertEqual(self.client.delete(f"{self.url}/branches/{b}/").status_code, 400)

    def test_library_updates_leave_merged_branches_alone(self):
        part = UserPart.objects.create(owner=self.user, part=_grid_part())
        copy_def = {**_grid_part(), "id": "custom-copy", "symbol": "custom-footprint-custom-copy",
                    "library": {"id": str(part.id), "rev": 1}}
        main = self.project.main_branch
        main.data = _design(componentDefs=[copy_def])
        main.save()
        b = self._branch("b")
        self._merge(self.main, b)
        before = Branch.objects.get(id=b).updated_at
        self.client.put(f"/api/users/me/parts/{part.id}/", content_type="application/json",
                        data=json.dumps({"part": _grid_part(name="Relay 2"), "update_projects": True}))
        closed = Branch.objects.get(id=b)
        self.assertEqual(closed.data["componentDefs"][0]["name"], "Relay")
        self.assertEqual(closed.updated_at, before)
        self.assertEqual(_main(self.project)["componentDefs"][0]["name"], "Relay 2")

    def test_saving_to_a_gone_branch_says_why(self):
        b = self._branch("b")
        c = self._branch("c")
        self._merge(self.main, b)
        res = self.client.put(f"{self.url}/", data=json.dumps({"branch": b, "data": _design()}), content_type="application/json")
        self.assertEqual((res.status_code, res.json()["code"]), (400, "branch_closed"))
        self.assertEqual(self.client.delete(f"{self.url}/branches/{c}/").status_code, 204)
        res = self.client.put(f"{self.url}/", data=json.dumps({"branch": c, "data": _design()}), content_type="application/json")
        self.assertEqual((res.status_code, res.json()["code"]), (404, "branch_missing"))

    def test_a_branch_deleted_mid_merge_is_a_conflict_not_a_crash(self):
        b = self._branch("b")
        prep = self.client.get(f"{self.url}/branches/{self.main}/merge/?source={b}").json()
        Branch.objects.filter(id=b).delete()
        res = self._post(f"/branches/{self.main}/merge/", {"source": b, "data": prep["target"]["data"],
                                                            "source_version": prep["source"]["version"],
                                                            "target_version": prep["target"]["version"]})
        self.assertIn(res.status_code, (400, 409))


def ungz_json(blob):
    import gzip
    return json.loads(gzip.decompress(bytes(blob)))


class ForkTests(TestCase):
    """A fork's main follows the original's main: it can take in the
    original's changes, never hand its own back."""

    def setUp(self):
        self.original = Project.create_with_main(_design(notes="v1"), name="Fuzz")
        self.client = Client()
        res = self.client.post(f"/api/projects/fork/{self.original.view_uuid}/")
        self.assertEqual(res.status_code, 201)
        self.fork_json = res.json()
        self.fork = Project.objects.get(edit_uuid=res.json()["edit_uuid"])

    def test_fork_main_has_the_original_main_as_parent(self):
        self.assertEqual(self.fork.main_branch.parent_id, self.original.main_branch_id)
        self.assertEqual(self.fork.fork_of_id, self.original.id)
        up = self.fork_json["upstream"]
        self.assertEqual(up["view_uuid"], str(self.original.view_uuid))
        self.assertEqual(up["branch"], str(self.original.main_branch_id))
        main = next(b for b in self.fork_json["branches"] if b["is_main"])
        self.assertTrue(main["upstream"])
        self.assertIsNone(main["parent"], "the original's branch id is only given as upstream")

    def test_fork_never_reveals_the_original_edit_uuid(self):
        edit = str(self.original.edit_uuid)
        for res in (
            self.client.get(f"/api/projects/{self.fork.edit_uuid}/"),
            self.client.get(f"/api/projects/view/{self.fork.view_uuid}/"),
            self.client.get(f"/api/projects/{self.fork.edit_uuid}/branches/{self.fork.main_branch_id}/merge/"
                            f"?source={self.original.main_branch_id}"),
        ):
            self.assertNotIn(edit, res.content.decode())
            self.assertNotIn(self.original.edit_uuid.hex, res.content.decode())
        view = self.client.get(f"/api/projects/view/{self.fork.view_uuid}/").json()
        self.assertNotIn("upstream", view)
        self.assertNotIn(str(self.original.view_uuid), json.dumps(view), "a fork's view link does not lead to the original")

    def test_take_in_the_originals_changes(self):
        orig_main = self.original.main_branch
        orig_main.data = _design(notes="v2")
        orig_main.save()
        fork_main = str(self.fork.main_branch_id)
        url = f"/api/projects/{self.fork.edit_uuid}/branches/{fork_main}/merge/"
        prep = self.client.get(f"{url}?source={orig_main.id}").json()
        self.assertEqual(prep["kind"], "from-parent")
        self.assertEqual((prep["base"]["notes"], prep["source"]["data"]["notes"]), ("v1", "v2"))
        res = self.client.post(url, content_type="application/json", data=json.dumps({
            "source": str(orig_main.id), "data": _design(notes="v2"),
            "source_version": prep["source"]["version"], "target_version": prep["target"]["version"],
        }))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(_main(self.fork)["notes"], "v2")
        self.assertEqual(_main(self.original)["notes"], "v2")

    def test_the_fork_cannot_merge_into_the_original(self):
        url = f"/api/projects/{self.original.edit_uuid}/branches/{self.original.main_branch_id}/merge/"
        self.assertEqual(self.client.get(f"{url}?source={self.fork.main_branch_id}").status_code, 400)


class DuplicateHistoryTests(TestCase):
    def test_duplicate_copies_branches_and_merges(self):
        user = User.objects.create_user("dup", password="x" * 64)
        client = Client()
        client.force_login(user)
        upstream = Project.create_with_main(_design(), name="Up")
        fork = Project.objects.get(edit_uuid=client.post(f"/api/projects/fork/{upstream.view_uuid}/").json()["edit_uuid"])
        url = f"/api/projects/{fork.edit_uuid}"
        b = client.post(f"{url}/branches/", content_type="application/json",
                        data=json.dumps({"name": "rev B", "from": str(fork.main_branch_id)})).json()["branch"]
        main = str(fork.main_branch_id)
        prep = client.get(f"{url}/branches/{main}/merge/?source={b}").json()
        client.post(f"{url}/branches/{main}/merge/", content_type="application/json", data=json.dumps({
            "source": b, "data": _design(notes="m"),
            "source_version": prep["source"]["version"], "target_version": prep["target"]["version"]}))

        res = client.post(f"{url}/duplicate/")
        self.assertEqual(res.status_code, 201)
        copy = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        branches = {x.name: x for x in copy.branches.all()}
        self.assertEqual(set(branches), {"main", "rev B"})
        self.assertEqual(copy.main_branch_id, branches["main"].id)
        self.assertEqual(branches["rev B"].parent_id, branches["main"].id, "parents point into the copy")
        self.assertEqual(branches["main"].parent_id, upstream.main_branch_id, "a copy of a fork still follows the original")
        self.assertEqual(branches["main"].data["notes"], "m")
        self.assertIsNotNone(branches["rev B"].closed_at, "a merged branch stays closed in the copy")
        merge = copy.merges.get()
        self.assertEqual((merge.source_id, merge.target_id), (branches["rev B"].id, branches["main"].id))
        self.assertEqual(fork.branches.count(), 2, "the original keeps its own")


class PartLibraryBranchTests(TestCase):
    def test_update_reaches_every_branch_but_the_open_one(self):
        user = User.objects.create_user("lib", password="x" * 64)
        client = Client()
        client.force_login(user)
        part = UserPart.objects.create(owner=user, part=_grid_part())
        copy_def = {**_grid_part(), "id": "custom-copy", "symbol": "custom-footprint-custom-copy",
                    "library": {"id": str(part.id), "rev": 1}}
        project = Project.create_with_main(_design(componentDefs=[copy_def]), name="P", owner=user)
        url = f"/api/projects/{project.edit_uuid}"
        b = client.post(f"{url}/branches/", content_type="application/json",
                        data=json.dumps({"name": "b", "from": str(project.main_branch_id)})).json()["branch"]
        c = client.post(f"{url}/branches/", content_type="application/json",
                        data=json.dumps({"name": "c", "from": str(project.main_branch_id)})).json()["branch"]
        res = client.put(f"/api/users/me/parts/{part.id}/", content_type="application/json", data=json.dumps({
            "part": _grid_part(name="Relay 2"), "update_projects": True, "skip_branch": b}))
        self.assertEqual(res.json()["updated_projects"], 1)
        names = {x.name: x.data["componentDefs"][0]["name"] for x in project.branches.all()}
        self.assertEqual(names, {"main": "Relay 2", "b": "Relay", "c": "Relay 2"})
        usage = client.get(f"/api/users/me/parts/{part.id}/usage/").json()
        self.assertEqual([u["name"] for u in usage], ["P"], "one entry per project")


def _board(name="Strips of three", rows=2, cols=3):
    """A board of `rows` strips of `cols` holes."""
    hole_line = "-".join(["o"] * cols)
    link_line = " ".join([" "] * cols)
    board_map = []
    for r in range(rows):
        board_map.append(hole_line)
        if r < rows - 1:
            board_map.append(link_line)
    return {"name": name, "map": board_map}


class BoardLibraryTests(TestCase):
    """The per-user board library: storage, validation, limits, ownership,
    and carrying an edit into the projects on a linked copy."""

    def setUp(self):
        self.user = User.objects.create_user("boards", password="x" * 64)
        self.client = Client()
        self.client.force_login(self.user)

    def _post(self, board):
        return self.client.post("/api/users/me/boards/", data=json.dumps({"board": board}), content_type="application/json")

    def _project_on(self, board_id, rev=1, name="P"):
        board = _board()
        pattern = {**board, "library": {"id": board_id, "rev": rev}}
        comp = {"id": "r1", "defId": "def-resistor", "boardPos": {"row": 0, "col": 0}}
        data = _design(components=[comp], board={"rows": 2, "cols": 3, "cuts": [], "wires": [], "pattern": pattern})
        return Project.create_with_main(data, owner=self.user, name=name)

    def test_create_list_delete(self):
        res = self._post({**_board(), "library": {"id": "x", "rev": 4}, "builtin": "tripad"})
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["board"], _board(), "the library keeps only the name and the copper")
        board_id = res.json()["id"]
        self.assertEqual([b["id"] for b in self.client.get("/api/users/me/boards/").json()], [board_id])
        self.assertEqual(self.client.delete(f"/api/users/me/boards/{board_id}/").status_code, 204)
        self.assertEqual(self.client.get("/api/users/me/boards/").json(), [])

    def test_requires_login_and_ownership(self):
        self.assertIn(Client().get("/api/users/me/boards/").status_code, (401, 403))
        other = User.objects.create_user("other", password="x" * 64)
        theirs = UserBoard.objects.create(owner=other, board=_board())
        self.assertEqual(self.client.delete(f"/api/users/me/boards/{theirs.id}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/users/me/boards/{theirs.id}/usage/").status_code, 404)

    def test_rejects_boards_the_editor_cannot_show(self):
        bad = [
            {"name": "x"},
            {**_board(), "name": ""},
            {**_board(), "name": "n" * 81},
            {**_board(), "map": []},
            {**_board(), "map": ["o-o", " "]},
            {**_board(), "map": ["o-o", "  ", "o-o"]},
            {**_board(), "map": ["o-x"]},
            {**_board(), "map": ["o-o", "-  ", "o-o"]},
            {**_board(), "map": [". ."]},
            {**_board(), "map": [7]},
            _board(rows=101, cols=1),
        ]
        for board in bad:
            self.assertEqual(self._post(board).status_code, 400, board)
        self.assertEqual(self._post({**_board(), "map": ["o-o", "|  ", "o ."]}).status_code, 201)

    def test_library_limit(self):
        UserBoard.objects.bulk_create([UserBoard(owner=self.user, board=_board()) for _ in range(200)])
        res = self._post(_board())
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["code"], "library_full")

    def test_import_is_all_or_nothing(self):
        url = "/api/users/me/boards/import/"
        res = self.client.post(url, content_type="application/json", data=json.dumps({"boards": [_board(), {"name": "x"}]}))
        self.assertEqual(res.status_code, 400)
        self.assertIn("Board 2", res.json()["error"])
        self.assertEqual(UserBoard.objects.count(), 0)
        res = self.client.post(url, content_type="application/json", data=json.dumps({"boards": [_board("A"), _board("B")]}))
        self.assertEqual([b["board"]["name"] for b in res.json()], ["A", "B"])

    def test_update_reaches_linked_projects_on_request(self):
        board = UserBoard.objects.create(owner=self.user, board=_board())
        linked = self._project_on(str(board.id))
        unlinked = Project.create_with_main(_design(), owner=self.user, name="Plain")
        url = f"/api/users/me/boards/{board.id}/"
        bigger = _board(name="Bigger", rows=3, cols=5)
        res = self.client.put(url, content_type="application/json", data=json.dumps({"board": bigger}))
        self.assertEqual((res.json()["rev"], res.json()["updated_projects"]), (2, 0))
        self.assertEqual(_main(linked)["board"]["pattern"]["name"], "Strips of three", "without update_projects nothing moves")
        res = self.client.put(url, content_type="application/json", data=json.dumps({"board": bigger, "update_projects": True}))
        self.assertEqual(res.json()["updated_projects"], 1)
        data = _main(linked)
        self.assertEqual((data["board"]["rows"], data["board"]["cols"]), (3, 5))
        self.assertEqual(data["board"]["pattern"], {**bigger, "library": {"id": str(board.id), "rev": 3}})
        self.assertEqual(data["components"][0]["boardPos"], {"row": 0, "col": 0}, "the editor fits parts when it opens the project")
        self.assertNotIn("pattern", _main(unlinked)["board"])

    def test_update_skips_the_open_branch_and_usage_counts_projects(self):
        board = UserBoard.objects.create(owner=self.user, board=_board())
        project = self._project_on(str(board.id))
        purl = f"/api/projects/{project.edit_uuid}"
        b = self.client.post(f"{purl}/branches/", content_type="application/json",
                             data=json.dumps({"name": "b", "from": str(project.main_branch_id)})).json()["branch"]
        res = self.client.put(f"/api/users/me/boards/{board.id}/", content_type="application/json", data=json.dumps({
            "board": _board(name="New"), "update_projects": True, "skip_branch": b}))
        self.assertEqual(res.json()["updated_projects"], 1)
        names = {x.name: x.data["board"]["pattern"]["name"] for x in project.branches.all()}
        self.assertEqual(names, {"main": "New", "b": "Strips of three"})
        usage = self.client.get(f"/api/users/me/boards/{board.id}/usage/").json()
        self.assertEqual(usage, [{"edit_uuid": str(project.edit_uuid), "name": "P", "placed": 1}])
        listed = self.client.get("/api/users/me/boards/?usage=1").json()
        self.assertEqual(listed[0]["used_in"], 1)

