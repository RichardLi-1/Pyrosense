from setuptools import setup

package_name = "voc_sensor"
setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="hazard team",
    maintainer_email="jonathan@brikli.com",
    description="SGP30 VOC driver and map-frame point mapper",
    license="MIT",
    entry_points={"console_scripts": [
        "voc_driver = voc_sensor.voc_driver:main",
        "voc_mapper = voc_sensor.voc_mapper:main",
    ]},
)
