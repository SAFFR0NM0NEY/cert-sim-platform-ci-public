"""Small snapshot checks without native templates, containers or app processes."""

from copy import deepcopy
import unittest

from serve import native_snapshot


class NativeSnapshot(unittest.TestCase):
    def test_runtime_removed_from_current_and_activity_start_without_mutation(self):
        source = {
            "dhcpTime": 120,
            "devices": [{
                "ports": [{"ip": "192.0.2.10", "addressMode": "dhcp",
                           "dhcpLease": {"expires": 86400}, "dhcpRetryAt": 121}],
                "services": {
                    "dhcp": {"enabled": True, "pools": [{"name": "Learners"}],
                             "leases": [{"ip": "192.0.2.10"}]},
                    "dns": {"enabled": False, "records": []},
                },
            }],
        }
        source["activity"] = {"initial": deepcopy(source)}
        before = deepcopy(source)
        result = native_snapshot(source)
        self.assertEqual(source, before)
        for snapshot in (result, result["activity"]["initial"]):
            self.assertNotIn("dhcpTime", snapshot)
            device = snapshot["devices"][0]
            self.assertEqual(device["ports"], [{"ip": "192.0.2.10", "addressMode": "dhcp"}])
            self.assertEqual(device["services"]["dhcp"], {
                "enabled": True, "pools": [{"name": "Learners"}], "leases": [],
            })
            self.assertEqual(device["services"]["dns"], before["devices"][0]["services"]["dns"])

    def test_does_not_create_services_or_drop_unsupported_configuration(self):
        source = {"devices": [{"ports": [{"ipv6": "2001:db8::1"}],
                               "unknownConfiguration": {"enabled": True}}]}
        self.assertEqual(native_snapshot(source), source)

    def test_transient_lease_change_has_identical_native_snapshot(self):
        first = {"devices": [{"ports": [], "services": {
            "dhcp": {"enabled": True, "pools": [], "leases": []},
        }}]}
        later = deepcopy(first)
        later["dhcpTime"] = 20
        later["devices"][0]["services"]["dhcp"]["leases"] = [{"expires": 86420}]
        self.assertEqual(native_snapshot(first), native_snapshot(later))
