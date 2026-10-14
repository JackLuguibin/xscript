"""Run on a device with XScript in the foreground. No network service is needed."""
import time
from ascript.android import location, sms
from ascript.android.sensor import AccelerometerSensor, LightSensor
from ascript.android.system import permission

# SMS permission is optional for this example. No message body or address is logged.
print("SMS permission:", sms.has_permission())
if sms.has_permission():
    print("Recent SMS count:", len(sms.get_recent(3)))

@AccelerometerSensor.on()
def acceleration(event):
    print("Acceleration:", event.x, event.y, event.z)

@LightSensor.on()
def light(event):
    print("Light:", event.value)

try:
    if permission.ensure(permission.LOCATION):
        location.request(lambda point: print("Location provider:", point.getProvider()))
    # The callbacks use daemon workers; keep this project alive while listening.
    time.sleep(5)
finally:
    AccelerometerSensor.stop()
    LightSensor.stop()
    location.close()
