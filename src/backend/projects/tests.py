import json
import os

from django.contrib.auth.models import User
from django.test import Client, TestCase

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
from projects.models import Project


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
        self.project = Project.objects.create(name="Test", data=_v1_dip8_payload())

    def test_put_v1_payload_migrates_and_persists(self):
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": _v1_dip8_payload()}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        # Response carries migrated data...
        body = res.json()
        self.assertEqual(body["data"]["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(body["data"]["schematicWires"][0]["start"], {"x": 140, "y": 180})
        # ...and the DB row matches.
        self.project.refresh_from_db()
        self.assertEqual(self.project.data["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(self.project.data["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_put_current_payload_unchanged(self):
        payload = {"version": CURRENT_SCHEMA_VERSION, "components": [], "schematicWires": [], "netLabels": [], "wiring": "touch"}
        res = Client().put(
            f"/api/projects/{self.project.edit_uuid}/",
            data=json.dumps({"name": "Test", "data": payload}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.data, payload)

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
        self.assertEqual(self.project.data["version"], CURRENT_SCHEMA_VERSION)
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
        for w in self.project.data["schematicWires"]:
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
        self.assertEqual(project.data["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(project.data["schematicWires"][0]["start"], {"x": 140, "y": 180})

    def test_post_current_payload_unchanged(self):
        payload = {"version": CURRENT_SCHEMA_VERSION, "components": [], "schematicWires": [], "netLabels": [], "wiring": "touch"}
        res = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "New", "data": payload}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 201)
        project = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertEqual(project.data, payload)


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
        original = Project.objects.create(name="old", data={
            "version": 2, "components": [], "nets": [], "netAssignments": [],
            "schematicWires": [{"id": "w1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 60}, "routeDirection": "vertical-first"}],
            "board": {"rows": 10, "cols": 10, "cuts": [], "wires": []},
        })
        res = Client().post(f"/api/projects/fork/{original.view_uuid}/")
        self.assertEqual(res.status_code, 201)
        forked = Project.objects.get(edit_uuid=res.json()["edit_uuid"])
        self.assertEqual(forked.data["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(len(forked.data["schematicWires"]), 2)
        self.assertEqual(original.data["version"], 2, "the original row is left alone")


class ReadHookTests(TestCase):
    """GET responses migrate on the fly (nothing is written), so a row the
    one-shot command has not reached yet, or a view-only visitor, still gets
    current-schema data."""

    def setUp(self):
        self.project = Project.objects.create(name="old", data={
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
        self.assertEqual(self.project.data["version"], 2, "reading never writes")

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
