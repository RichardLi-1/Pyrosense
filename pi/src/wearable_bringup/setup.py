from glob import glob
from setuptools import setup

package_name = "wearable_bringup"
setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", glob("launch/*.py")),
        ("share/" + package_name + "/config", glob("config/*.yaml")),
        ("share/" + package_name + "/systemd", glob("systemd/*")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="hazard team",
    maintainer_email="jonathan@brikli.com",
    description="Launch + config for the wearable mapper",
    license="MIT",
)
